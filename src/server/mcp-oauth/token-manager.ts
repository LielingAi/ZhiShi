/**
 * MCP OAuth Token Manager
 *
 * Manages the token lifecycle:
 * - resolveAuthHeaders(): the single entry point for token consumption
 * - Token refresh with auto-retry
 * - Background refresh scheduler (proactive, before expiry)
 * - Event-driven notifications (acquired/refreshed/expired/revoked)
 */

import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getOAuthConfigDir, getServerState, updateServerState, loadStateStore } from './state-store';
import type { OAuthTokenData, TokenChangeEvent, TokenChangeListener } from './types';
import { ensureDirSync } from '../utils/fs-utils';

// ===== Constants =====

const REFRESH_BUFFER_MS = 5 * 60 * 1000;   // Refresh 5 min before expiry
const INLINE_REFRESH_BUFFER_MS = 60 * 1000; // For inline checks, 60s buffer
const SCHEDULER_INTERVAL_MS = 60 * 1000;    // Check every 60s
const REFRESH_LOCK_TIMEOUT_MS = 20 * 1000;
const REFRESH_LOCK_STALE_MS = 30 * 1000;
const REFRESH_LOCK_RETRY_MS = 100;

// ===== Event System =====

const listeners: TokenChangeListener[] = [];

/** Register a listener for token change events */
export function onTokenChange(listener: TokenChangeListener): void {
  listeners.push(listener);
}

/** Emit a token change event to all listeners */
export function emitTokenChange(serverId: string, event: TokenChangeEvent): void {
  console.log(`[mcp-oauth] Token event: ${serverId} → ${event}`);
  for (const listener of listeners) {
    try {
      listener(serverId, event);
    } catch (err) {
      console.error('[mcp-oauth] Token change listener error:', err);
    }
  }
}

// ===== Token Refresh =====

// Single-flight guard: prevents concurrent refresh calls for the same server.
// With rotating refresh tokens, two concurrent refreshes would use the same
// refresh_token — the second call would fail because the token was already consumed.
const refreshInFlight = new Map<string, Promise<OAuthTokenData | null>>();

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function lockNameForServer(serverId: string): string {
  return encodeURIComponent(serverId).replace(/%/g, '_');
}

async function acquireRefreshLock(serverId: string): Promise<() => void> {
  const locksDir = join(getOAuthConfigDir(), 'mcp_oauth_locks');
  const lockDir = join(locksDir, `${lockNameForServer(serverId)}.lock`);
  const startedAt = Date.now();

  ensureDirSync(locksDir);

  while (true) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      writeFileSync(join(lockDir, 'owner'), `${process.pid}\n`, { encoding: 'utf-8' });
      return () => {
        try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* noop */ }
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;

      try {
        const ageMs = Date.now() - statSync(lockDir).mtimeMs;
        if (ageMs > REFRESH_LOCK_STALE_MS) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        if (!existsSync(lockDir)) continue;
      }

      if (Date.now() - startedAt > REFRESH_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for OAuth refresh lock for ${serverId}`);
      }

      await sleep(REFRESH_LOCK_RETRY_MS);
    }
  }
}

async function withRefreshLock<T>(serverId: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireRefreshLock(serverId);
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Refresh an expired/expiring token using the refresh_token grant.
 * Single-flight: concurrent calls for the same serverId share one request.
 * Returns new token data or null if refresh fails.
 */
export async function refreshToken(serverId: string): Promise<OAuthTokenData | null> {
  // Return existing in-flight refresh if one is running
  const existing = refreshInFlight.get(serverId);
  if (existing) return existing;

  const promise = refreshTokenInner(serverId);
  refreshInFlight.set(serverId, promise);
  try {
    return await promise;
  } catch (err) {
    console.error(`[mcp-oauth] Token refresh error for ${serverId}:`, err);
    return null;
  } finally {
    refreshInFlight.delete(serverId);
  }
}

async function refreshTokenInner(serverId: string): Promise<OAuthTokenData | null> {
  return withRefreshLock(serverId, async () => {
    const state = loadStateStore(true)[serverId];
    if (!state?.token?.refreshToken) {
      console.warn(`[mcp-oauth] No refresh token for ${serverId}`);
      return null;
    }
    if (state.token.expiresAt && state.token.expiresAt >= Date.now() + INLINE_REFRESH_BUFFER_MS) {
      return state.token;
    }

    // Resolve clientId and tokenEndpoint from registration or manualConfig
    const clientId = state.registration?.clientId ?? state.manualConfig?.clientId;
    const tokenEndpoint = state.manualConfig?.tokenUrl ?? state.discovery?.tokenEndpoint;

    if (!tokenEndpoint) {
      console.warn(`[mcp-oauth] No token endpoint for ${serverId}, cannot refresh`);
      return null;
    }

    try {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: state.token.refreshToken,
      });
      // RFC 6749 Section 6: public clients MUST include client_id on refresh
      if (clientId) {
        body.set('client_id', clientId);
      }
      // Include client_secret if available (confidential clients)
      const clientSecret = state.registration?.clientSecret ?? state.manualConfig?.clientSecret;
      if (clientSecret) {
        body.set('client_secret', clientSecret);
      }

      const response = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: body.toString(),
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        console.error(`[mcp-oauth] Token refresh failed for ${serverId}: HTTP ${response.status} ${text.slice(0, 200)}`);
        return null;
      }

      const data = await response.json() as {
        access_token: string;
        token_type?: string;
        expires_in?: number;
        refresh_token?: string;
        scope?: string;
      };

      if (!data.access_token) return null;

      const newToken: OAuthTokenData = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || state.token.refreshToken,
        tokenType: data.token_type || 'Bearer',
        expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
        scope: data.scope || state.token.scope,
      };

      await updateServerState(serverId, { token: newToken });
      console.log(`[mcp-oauth] Token refreshed for ${serverId}`);
      return newToken;
    } catch (err) {
      console.error(`[mcp-oauth] Token refresh error for ${serverId}:`, err);
      return null;
    }
  });
}

// ===== resolveAuthHeaders — The Single Token Entry Point =====

/**
 * Get valid Authorization headers for an MCP server.
 *
 * This is the ONLY function other modules should call for token consumption.
 * It handles everything: check → refresh if needed → return headers.
 *
 * @returns { Authorization: 'Bearer xxx' } or {} if no valid token
 */
export async function resolveAuthHeaders(
  serverId: string,
): Promise<Record<string, string>> {
  const state = getServerState(serverId);
  if (!state?.token) return {};

  const token = state.token;

  // Check expiry with inline buffer (60s)
  if (token.expiresAt && token.expiresAt < Date.now() + INLINE_REFRESH_BUFFER_MS) {
    // Token expired or expiring soon — try refresh
    if (token.refreshToken) {
      const refreshed = await refreshToken(serverId);
      if (refreshed) {
        return { Authorization: `${refreshed.tokenType || 'Bearer'} ${refreshed.accessToken}` };
      }
    }
    // Refresh failed or no refresh token — return empty
    return {};
  }

  return { Authorization: `${token.tokenType || 'Bearer'} ${token.accessToken}` };
}

// ===== Background Refresh Scheduler =====

let schedulerTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the background token refresh scheduler.
 * Checks all tokens every 60s and proactively refreshes tokens expiring within 5 min.
 *
 * Should be called once at Sidecar initialization.
 */
export function startTokenRefreshScheduler(): void {
  if (schedulerTimer) return; // Already started

  schedulerTimer = setInterval(async () => {
    const store = loadStateStore();

    // Collect refresh tasks and run them in parallel so one slow server
    // doesn't block checks for others (each has its own 15s timeout)
    const tasks: Promise<void>[] = [];

    for (const [serverId, state] of Object.entries(store)) {
      if (!state.token?.expiresAt) continue;

      const timeToExpiry = state.token.expiresAt - Date.now();

      if (timeToExpiry <= 0) {
        // Already expired
        if (state.token.refreshToken) {
          tasks.push(refreshToken(serverId).then(r => {
            emitTokenChange(serverId, r ? 'refreshed' : 'expired');
          }));
        } else {
          emitTokenChange(serverId, 'expired');
        }
      } else if (timeToExpiry < REFRESH_BUFFER_MS && state.token.refreshToken) {
        // Expiring soon — proactive refresh
        tasks.push(refreshToken(serverId).then(r => {
          if (r) emitTokenChange(serverId, 'refreshed');
          // If proactive refresh fails, don't emit expired yet — still valid until actual expiry
        }));
      }
    }

    if (tasks.length > 0) {
      await Promise.allSettled(tasks);
    }
  }, SCHEDULER_INTERVAL_MS);

  console.log('[mcp-oauth] Token refresh scheduler started');
}

/** Stop the scheduler (for testing or cleanup) */
