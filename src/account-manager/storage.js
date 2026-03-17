/**
 * Account Storage
 *
 * Handles loading and saving account configuration to disk.
 */

import { readFile, writeFile, mkdir, access, rename } from 'fs/promises';
import { constants as fsConstants } from 'fs';
import { dirname } from 'path';
import { ACCOUNT_CONFIG_PATH } from '../constants.js';
import { getAuthStatus } from '../auth/database.js';
import { logger } from '../utils/logger.js';

let writeLock = null;

/**
 * Load accounts from the config file and/or environment variables.
 * On App Runner, ACCOUNTS_JSON env var is often used for initial seeding.
 * We merge them so that updated tokens on disk take precedence.
 *
 * @param {string} configPath - Path to the config file
 * @returns {Promise<{accounts: Array, settings: Object, activeIndex: number}>}
 */
export async function loadAccounts(configPath = ACCOUNT_CONFIG_PATH) {
    let envConfig = null;
    let diskConfig = null;

    // 1. Load from environment variable (Seeding mode)
    if (process.env.ACCOUNTS_JSON) {
        try {
            const parsed = JSON.parse(process.env.ACCOUNTS_JSON);
            envConfig = Array.isArray(parsed) ? { accounts: parsed } : parsed;
            logger.info(`[AccountManager] Found ${envConfig.accounts?.length || 0} accounts in ACCOUNTS_JSON environment variable`);
        } catch (e) {
            logger.error('[AccountManager] Failed to parse ACCOUNTS_JSON env var:', e.message);
        }
    }

    // 2. Load from disk (Persistence mode)
    try {
        await access(configPath, fsConstants.F_OK);
        const configData = await readFile(configPath, 'utf-8');
        diskConfig = JSON.parse(configData);
        logger.info(`[AccountManager] Loaded ${diskConfig.accounts?.length || 0} accounts from disk: ${configPath}`);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            logger.error('[AccountManager] Failed to load disk config:', error.message);
        }
    }

    // 3. Merge Strategy:
    // - If both exist: Merge by email. Disk version takes precedence for tokens/ids.
    // - If only env exists: Use env.
    // - If only disk exists: Use disk.
    // - If none: Return empty.
    let mergedConfig = { accounts: [], settings: {}, activeIndex: 0 };

    if (envConfig || diskConfig) {
        const accountsMap = new Map();
        
        // Load env accounts first
        if (envConfig?.accounts) {
            envConfig.accounts.forEach(acc => {
                if (acc && acc.email) accountsMap.set(acc.email, { ...acc, _source: 'env' });
            });
        }

        // Override with disk accounts (they contain fresher refresh tokens)
        if (diskConfig?.accounts) {
            diskConfig.accounts.forEach(acc => {
                if (acc && acc.email) {
                    accountsMap.set(acc.email, { 
                        ...(accountsMap.get(acc.email) || {}), 
                        ...acc,
                        _source: 'disk' 
                    });
                }
            });
        }

        mergedConfig = {
            settings: diskConfig?.settings || envConfig?.settings || {},
            activeIndex: diskConfig?.activeIndex || envConfig?.activeIndex || 0,
            accounts: Array.from(accountsMap.values())
        };
    }

    try {
        const accounts = (mergedConfig.accounts || []).map(acc => ({
            ...acc,
            lastUsed: acc.lastUsed || null,
            enabled: acc.enabled !== false,
            // Reset invalid flag on startup unless it needs user intervention
            isInvalid: acc.verifyUrl ? (acc.isInvalid || false) : false,
            invalidReason: acc.verifyUrl ? (acc.invalidReason || null) : null,
            verifyUrl: acc.verifyUrl || null,
            modelRateLimits: acc.modelRateLimits || {},
            subscription: acc.subscription || { tier: 'unknown', projectId: null, detectedAt: null },
            quota: acc.quota || { models: {}, lastChecked: null },
            quotaThreshold: acc.quotaThreshold,
            modelQuotaThresholds: acc.modelQuotaThresholds || {}
        }));

        const settings = mergedConfig.settings || {};
        let activeIndex = mergedConfig.activeIndex || 0;

        if (activeIndex >= accounts.length) activeIndex = 0;

        return { accounts, settings, activeIndex };
    } catch (error) {
        logger.error('[AccountManager] Error processing merged accounts:', error.message);
        return { accounts: [], settings: {}, activeIndex: 0 };
    }
}

/**
 * Load the default account from Antigravity's database
 *
 * @param {string} dbPath - Optional path to the database
 * @returns {{accounts: Array, tokenCache: Map}}
 */
export function loadDefaultAccount(dbPath) {
    try {
        const authData = getAuthStatus(dbPath);
        if (authData?.apiKey) {
            const account = {
                email: authData.email || 'default@antigravity',
                source: 'database',
                lastUsed: null,
                modelRateLimits: {}
            };

            const tokenCache = new Map();
            tokenCache.set(account.email, {
                token: authData.apiKey,
                extractedAt: Date.now()
            });

            logger.info(`[AccountManager] Loaded default account: ${account.email}`);

            return { accounts: [account], tokenCache };
        }
    } catch (error) {
        logger.error('[AccountManager] Failed to load default account:', error.message);
    }

    return { accounts: [], tokenCache: new Map() };
}

/**
 * Save account configuration to disk
 *
 * @param {string} configPath - Path to the config file
 * @param {Array} accounts - Array of account objects
 * @param {Object} settings - Settings object
 * @param {number} activeIndex - Current active account index
 */
export async function saveAccounts(configPath, accounts, settings, activeIndex) {
    // Serialize writes to prevent concurrent corruption
    const previousLock = writeLock;
    let resolve;
    writeLock = new Promise(r => { resolve = r; });

    try {
        if (previousLock) await previousLock;
    } catch {
        // Previous write failed, proceed anyway
    }

    try {
        const dir = dirname(configPath);
        await mkdir(dir, { recursive: true });

        const config = {
            accounts: accounts.map(acc => ({
                email: acc.email,
                source: acc.source,
                enabled: acc.enabled !== false,
                dbPath: acc.dbPath || null,
                refreshToken: acc.source === 'oauth' ? acc.refreshToken : undefined,
                apiKey: acc.source === 'manual' ? acc.apiKey : undefined,
                projectId: acc.projectId || undefined,
                addedAt: acc.addedAt || undefined,
                isInvalid: acc.isInvalid || false,
                invalidReason: acc.invalidReason || null,
                verifyUrl: acc.verifyUrl || null,
                modelRateLimits: acc.modelRateLimits || {},
                lastUsed: acc.lastUsed,
                subscription: acc.subscription || { tier: 'unknown', projectId: null, detectedAt: null },
                quota: acc.quota || { models: {}, lastChecked: null },
                quotaThreshold: acc.quotaThreshold,
                modelQuotaThresholds: Object.keys(acc.modelQuotaThresholds || {}).length > 0 ? acc.modelQuotaThresholds : undefined
            })),
            settings: settings,
            activeIndex: activeIndex
        };

        const json = JSON.stringify(config, null, 2);

        // Validate JSON before writing (prevent saving corrupt data)
        JSON.parse(json);

        // Atomic write: write to temp file then rename
        const tmpPath = configPath + '.tmp';
        await writeFile(tmpPath, json);
        await rename(tmpPath, configPath);
    } catch (error) {
        logger.error('[AccountManager] Failed to save config:', error.message);
    } finally {
        resolve();
    }
}
