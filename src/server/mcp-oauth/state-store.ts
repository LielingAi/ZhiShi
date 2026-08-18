/**
 * MCP OAuth State Store
 *
 * Persists all OAuth state (discovery, registration, tokens) to disk.
 * Handles atomic writes and migration from legacy mcp_oauth_tokens.json.
 *
 * File: ~/.zhishi/mcp_oauth_state.json (mode 0o600)
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { McpOAuthState, McpOAuthStateStore, LegacyOAuthToken } from './types';
import { ensureDirSync } from '../utils/fs-utils';
import { withFileLock } from '../utils/file-lock';
import { getZhiShiDataDir } from '../utils/app-dirs';

export function getOAuthConfigDir(): string {
  // Prefer ZHISHI_DATA_DIR (injected by Rust for USB portable mode),
  // then legacy ZHISHI_CONFIG_DIR, then default.
  return process.env.ZHISHI_DATA_DIR
    || process.env.ZHISHI_CONFIG_DIR
    || getZhiShiDataDir();
}

function getStateFile(): string {
  return join(getOAuthConfigDir(), 'mcp_oauth_state.json');
}

function getLegacyTokenFile(): string {
  return join(getOAuthConfigDir(), 'mcp_oauth_tokens.json');
}

/** 24h discovery cache validity */
export const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;
const WRITE_LOCK_TIMEOUT_MS = 10 * 1000;
const WRITE_LOCK_STALE_MS = 30 * 1000;

function ensureDir(): void {
  const configDir = getOAuthConfigDir();
  ensureDirSync(configDir);
}

function getStateLockPath(): string {
  const locksDir = join(getOAuthConfigDir(), 'mcp_oauth_locks');
  ensureDirSync(locksDir);
  return join(locksDir, 'state-store.lock');
}

// Per-async-chain reentrancy flag. Two concurrent callers each have their own
// ALS frame, so they don't bypass each other. A genuine recursive call from
// inside the lock's `op` (same async chain) sees the flag and skips re-locking.
const insideWriteLock = new AsyncLocalStorage<true>();

async function withWriteLock<T>(fn: () => T | Promise<T>): Promise<T> {
  if (insideWriteLock.getStore()) {
    return await fn();
  }

  return await withFileLock(
    {
      lockPath: getStateLockPath(),
      timeoutMs: WRITE_LOCK_TIMEOUT_MS,
      staleMs: WRITE_LOCK_STALE_MS,
    },
    async () => insideWriteLock.run(true, async () => fn()),
  );
}

/** Migrate legacy mcp_oauth_tokens.json to new state format */
function migrateFromLegacy(): McpOAuthStateStore {
  try {
    const legacyTokenFile = getLegacyTokenFile();
    if (!existsSync(legacyTokenFile)) return {};
    const raw = readFileSync(legacyTokenFile, 'utf-8');
    const legacy = JSON.parse(raw) as Record<string, LegacyOAuthToken>;
    const migrated: McpOAuthStateStore = {};

    for (const [serverId, old] of Object.entries(legacy)) {
      if (!old?.accessToken) continue;
      migrated[serverId] = {
        token: {
          accessToken: old.accessToken,
          refreshToken: old.refreshToken,
          tokenType: old.tokenType || 'Bearer',
          expiresAt: old.expiresAt,
          scope: old.scope,
        },
        // Legacy data was always manual config
        manualConfig: old.clientId ? { clientId: old.clientId } : undefined,
        // Store tokenEndpoint from legacy for refresh
        discovery: old.serverUrl ? {
          authServerUrl: '',
          authorizationEndpoint: '',
          tokenEndpoint: old.serverUrl,
          discoveredAt: 0, // Expired — will re-discover on next probe
        } : undefined,
      };
    }

    console.log(`[mcp-oauth] Migrated ${Object.keys(migrated).length} entries from legacy token file`);
    return migrated;
  } catch (err) {
    console.error('[mcp-oauth] Legacy migration failed:', err);
    return {};
  }
}

// In-memory mirror of the last parsed store. Disk remains the source of truth
// because OAuth state is shared by multiple sidecar processes.
let memoryCache: McpOAuthStateStore | null = null;
let memoryCacheFile: string | null = null;

/** Load the full OAuth state store from disk */
export function loadStateStore(_forceReload = false): McpOAuthStateStore {
  const stateFile = getStateFile();
  if (memoryCacheFile !== stateFile) {
    memoryCache = null;
    memoryCacheFile = stateFile;
  }

  try {
    if (existsSync(stateFile)) {
      const raw = readFileSync(stateFile, 'utf-8');
      memoryCache = JSON.parse(raw) as McpOAuthStateStore;
      return memoryCache;
    }
    // First load — try migration from legacy
    const migrated = migrateFromLegacy();
    if (Object.keys(migrated).length > 0) {
      // Fire-and-forget — first-load migration is best-effort, errors get logged.
      void saveStateStore(migrated).catch(err => {
        console.error('[mcp-oauth] Failed to persist migrated state:', err);
      });
      memoryCache = migrated;
      memoryCacheFile = stateFile;
    } else {
      memoryCache = migrated;
    }
    return migrated;
  } catch (err) {
    console.error('[mcp-oauth] Failed to load state store:', err);
    return memoryCache ?? {};
  }
}

function saveStateStoreUnlocked(store: McpOAuthStateStore): void {
  const stateFile = getStateFile();
  try {
    ensureDir();
    const tmpFile = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmpFile, JSON.stringify(store, null, 2), { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmpFile, stateFile);
    memoryCache = store;
    memoryCacheFile = stateFile;
  } catch (err) {
    console.error('[mcp-oauth] Failed to save state store:', err);
  }
}

/** Save the full state store to disk (atomic write via tmp+rename) and update cache */
export async function saveStateStore(store: McpOAuthStateStore): Promise<void> {
  try {
    await withWriteLock(() => saveStateStoreUnlocked(store));
  } catch (err) {
    console.error('[mcp-oauth] Failed to save state store:', err);
  }
}

/** Get state for a specific server */
export function getServerState(serverId: string): McpOAuthState | undefined {
  return loadStateStore()[serverId];
}

/** Update state for a specific server (merge) */
export async function updateServerState(serverId: string, patch: Partial<McpOAuthState>): Promise<void> {
  try {
    await withWriteLock(() => {
      const store = loadStateStore(true);
      store[serverId] = { ...store[serverId], ...patch };
      saveStateStoreUnlocked(store);
    });
  } catch (err) {
    console.error(`[mcp-oauth] Failed to update state for ${serverId}:`, err);
  }
}

/** Clear a specific field from server state */
export async function clearServerField(serverId: string, field: keyof McpOAuthState): Promise<void> {
  try {
    await withWriteLock(() => {
      const store = loadStateStore(true);
      if (store[serverId]) {
        delete store[serverId][field];
        // Remove empty entries
        if (Object.keys(store[serverId]).length === 0) {
          delete store[serverId];
        }
        saveStateStoreUnlocked(store);
      }
    });
  } catch (err) {
    console.error(`[mcp-oauth] Failed to clear ${field} for ${serverId}:`, err);
  }
}

/** Check if discovery cache is still valid */
export function isDiscoveryCacheValid(discovery: McpOAuthState['discovery']): boolean {
  if (!discovery?.discoveredAt) return false;
  return Date.now() - discovery.discoveredAt < DISCOVERY_TTL_MS;
}

export function resetStateStoreCacheForTests(): void {
  memoryCache = null;
  memoryCacheFile = null;
}
