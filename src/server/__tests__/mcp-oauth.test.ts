import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { dynamicRegister } from '../mcp-oauth/registration';
import { refreshToken } from '../mcp-oauth/token-manager';
import {
  clearServerField,
  getServerState,
  resetStateStoreCacheForTests,
  saveStateStore,
  updateServerState,
} from '../mcp-oauth/state-store';

const originalConfigDir = process.env.ZHISHI_CONFIG_DIR;
const originalFetch = globalThis.fetch;

let configDir: string;

function stateFile(): string {
  return join(configDir, 'mcp_oauth_state.json');
}

function writeExternalState(state: unknown): void {
  writeFileSync(stateFile(), JSON.stringify(state, null, 2), { encoding: 'utf-8', mode: 0o600 });
  const future = new Date(Date.now() + 1000);
  utimesSync(stateFile(), future, future);
}

describe('mcp oauth', () => {
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'zhishi-oauth-test-'));
    process.env.ZHISHI_CONFIG_DIR = configDir;
    resetStateStoreCacheForTests();
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    resetStateStoreCacheForTests();
    globalThis.fetch = originalFetch;
    if (originalConfigDir === undefined) {
      delete process.env.ZHISHI_CONFIG_DIR;
    } else {
      process.env.ZHISHI_CONFIG_DIR = originalConfigDir;
    }
    rmSync(configDir, { recursive: true, force: true });
  });

  test('dynamic registration advertises refresh token support', async () => {
    let registrationRequest: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_url, init) => {
      registrationRequest = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ client_id: 'client-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    await dynamicRegister(
      'https://auth.example.com/register',
      'http://127.0.0.1:12345/callback',
      ['mcp:tools'],
    );

    expect(registrationRequest?.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(registrationRequest?.token_endpoint_auth_method).toBe('none');
  });

  test('state store reloads OAuth credentials written by another process', async () => {
    await saveStateStore({
      notion: {
        registration: { clientId: 'old-client', registeredAt: 1 },
        token: {
          accessToken: 'old-access',
          refreshToken: 'old-refresh',
          tokenType: 'Bearer',
        },
      },
    });
    expect(getServerState('notion')?.registration?.clientId).toBe('old-client');

    writeExternalState({
      notion: {
        registration: { clientId: 'new-client', registeredAt: 2 },
        token: {
          accessToken: 'new-access',
          refreshToken: 'new-refresh',
          tokenType: 'Bearer',
        },
      },
    });

    const state = getServerState('notion');
    expect(state?.registration?.clientId).toBe('new-client');
    expect(state?.token?.refreshToken).toBe('new-refresh');
  });

  test('state updates merge against fresh disk state instead of stale cache', async () => {
    await saveStateStore({
      notion: {
        registration: { clientId: 'old-client', registeredAt: 1 },
      },
    });
    expect(getServerState('notion')?.registration?.clientId).toBe('old-client');

    writeExternalState({
      notion: {
        registration: { clientId: 'new-client', registeredAt: 2 },
        token: {
          accessToken: 'new-access',
          refreshToken: 'new-refresh',
          tokenType: 'Bearer',
        },
      },
    });

    await updateServerState('notion', {
      discovery: {
        authServerUrl: 'https://auth.example.com',
        authorizationEndpoint: 'https://auth.example.com/authorize',
        tokenEndpoint: 'https://auth.example.com/token',
        discoveredAt: Date.now(),
      },
    });

    const persisted = JSON.parse(readFileSync(stateFile(), 'utf-8'));
    expect(persisted.notion.registration.clientId).toBe('new-client');
    expect(persisted.notion.token.refreshToken).toBe('new-refresh');
    expect(persisted.notion.discovery.tokenEndpoint).toBe('https://auth.example.com/token');
  });

  test('state update can migrate legacy tokens while holding the write lock', async () => {
    writeFileSync(join(configDir, 'mcp_oauth_tokens.json'), JSON.stringify({
      notion: {
        accessToken: 'legacy-access',
        refreshToken: 'legacy-refresh',
        tokenType: 'Bearer',
        expiresAt: Date.now() + 3600_000,
        serverUrl: 'https://auth.example.com/token',
        clientId: 'legacy-client',
      },
    }), { encoding: 'utf-8', mode: 0o600 });

    const startedAt = Date.now();
    await updateServerState('notion', {
      registration: { clientId: 'new-client', registeredAt: Date.now() },
    });

    const persisted = JSON.parse(readFileSync(stateFile(), 'utf-8'));
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(persisted.notion.token.refreshToken).toBe('legacy-refresh');
    expect(persisted.notion.registration.clientId).toBe('new-client');
  });

  test('state clear can migrate legacy tokens while holding the write lock', async () => {
    writeFileSync(join(configDir, 'mcp_oauth_tokens.json'), JSON.stringify({
      notion: {
        accessToken: 'legacy-access',
        refreshToken: 'legacy-refresh',
        tokenType: 'Bearer',
        expiresAt: Date.now() + 3600_000,
        serverUrl: 'https://auth.example.com/token',
        clientId: 'legacy-client',
      },
    }), { encoding: 'utf-8', mode: 0o600 });

    const startedAt = Date.now();
    await clearServerField('notion', 'token');

    expect(Date.now() - startedAt).toBeLessThan(1000);
    const state = getServerState('notion');
    expect(state?.token).toBeUndefined();
    expect(state?.manualConfig?.clientId).toBe('legacy-client');
  });

  test('refresh uses the latest stored client credentials', async () => {
    await saveStateStore({
      notion: {
        discovery: {
          authServerUrl: 'https://auth.example.com',
          authorizationEndpoint: 'https://auth.example.com/authorize',
          tokenEndpoint: 'https://auth.example.com/token',
          discoveredAt: Date.now(),
        },
        registration: { clientId: 'old-client', registeredAt: 1 },
        token: {
          accessToken: 'old-access',
          refreshToken: 'old-refresh',
          tokenType: 'Bearer',
          expiresAt: Date.now() - 1000,
        },
      },
    });
    expect(getServerState('notion')?.registration?.clientId).toBe('old-client');

    writeExternalState({
      notion: {
        discovery: {
          authServerUrl: 'https://auth.example.com',
          authorizationEndpoint: 'https://auth.example.com/authorize',
          tokenEndpoint: 'https://auth.example.com/token',
          discoveredAt: Date.now(),
        },
        registration: { clientId: 'new-client', registeredAt: 2 },
        token: {
          accessToken: 'new-access',
          refreshToken: 'new-refresh',
          tokenType: 'Bearer',
          expiresAt: Date.now() - 1000,
        },
      },
    });

    let refreshRequest: URLSearchParams | undefined;
    globalThis.fetch = (async (_url, init) => {
      refreshRequest = new URLSearchParams(String(init?.body));
      return new Response(JSON.stringify({
        access_token: 'refreshed-access',
        refresh_token: 'refreshed-refresh',
        token_type: 'Bearer',
        expires_in: 3600,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const token = await refreshToken('notion');

    expect(refreshRequest?.get('client_id')).toBe('new-client');
    expect(refreshRequest?.get('refresh_token')).toBe('new-refresh');
    expect(token?.refreshToken).toBe('refreshed-refresh');
  });

  test('refresh reuses a token another process already refreshed', async () => {
    await saveStateStore({
      notion: {
        discovery: {
          authServerUrl: 'https://auth.example.com',
          authorizationEndpoint: 'https://auth.example.com/authorize',
          tokenEndpoint: 'https://auth.example.com/token',
          discoveredAt: Date.now(),
        },
        registration: { clientId: 'old-client', registeredAt: 1 },
        token: {
          accessToken: 'old-access',
          refreshToken: 'old-refresh',
          tokenType: 'Bearer',
          expiresAt: Date.now() - 1000,
        },
      },
    });
    expect(getServerState('notion')?.token?.accessToken).toBe('old-access');

    writeExternalState({
      notion: {
        discovery: {
          authServerUrl: 'https://auth.example.com',
          authorizationEndpoint: 'https://auth.example.com/authorize',
          tokenEndpoint: 'https://auth.example.com/token',
          discoveredAt: Date.now(),
        },
        registration: { clientId: 'new-client', registeredAt: 2 },
        token: {
          accessToken: 'fresh-access',
          refreshToken: 'fresh-refresh',
          tokenType: 'Bearer',
          expiresAt: Date.now() + 3600_000,
        },
      },
    });

    let refreshCalled = false;
    globalThis.fetch = (async (_url, _init) => {
      refreshCalled = true;
      return new Response('{}', { status: 500 });
    }) as typeof fetch;

    const token = await refreshToken('notion');

    expect(token?.accessToken).toBe('fresh-access');
    expect(token?.refreshToken).toBe('fresh-refresh');
    expect(refreshCalled).toBe(false);
  });

  test('concurrent saveStateStore calls serialize without losing entries', async () => {
    // Two separate async chains both writing to the same store. Without proper
    // per-chain reentrancy isolation, both could bypass the file lock and one
    // write could clobber the other (read-modify-write race).
    await saveStateStore({});

    const writeA = (async () => {
      await updateServerState('serverA', {
        registration: { clientId: 'client-a', registeredAt: 1 },
      });
    })();
    const writeB = (async () => {
      await updateServerState('serverB', {
        registration: { clientId: 'client-b', registeredAt: 2 },
      });
    })();

    await Promise.all([writeA, writeB]);

    const persisted = JSON.parse(readFileSync(stateFile(), 'utf-8'));
    expect(persisted.serverA?.registration?.clientId).toBe('client-a');
    expect(persisted.serverB?.registration?.clientId).toBe('client-b');
  });
});
