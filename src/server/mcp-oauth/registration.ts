/**
 * MCP OAuth Dynamic Client Registration
 *
 * Implements RFC 7591: OAuth 2.0 Dynamic Client Registration Protocol.
 * Desktop clients register as public clients (token_endpoint_auth_method: "none").
 */

import type { RegistrationResponse, RegistrationData } from './types';

const TIMEOUT_MS = 15000;

/**
 * Dynamically register an OAuth client with the authorization server.
 *
 * @param registrationEndpoint - The registration_endpoint from Auth Server Metadata
 * @param redirectUri - The callback URI (e.g., http://127.0.0.1:{port}/callback)
 * @param scopes - Optional scopes to request
 * @returns Registration result with client_id (and optional client_secret)
 */
export async function dynamicRegister(
  registrationEndpoint: string,
  redirectUri: string,
  scopes?: string[],
): Promise<RegistrationData> {
  const body = {
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    client_name: 'ZhiShi Desktop',
    ...(scopes?.length ? { scope: scopes.join(' ') } : {}),
  };

  console.log(`[mcp-oauth] Dynamic registration at ${registrationEndpoint}`);

  const res = await fetch(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Dynamic registration failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }

  const data = await res.json() as RegistrationResponse;
  if (!data.client_id) {
    throw new Error('Dynamic registration response missing client_id');
  }

  console.log(`[mcp-oauth] Dynamic registration successful: client_id=${data.client_id.slice(0, 8)}...`);

  return {
    clientId: data.client_id,
    clientSecret: data.client_secret,
    registeredAt: Date.now(),
    expiresAt: data.client_secret_expires_at
      ? data.client_secret_expires_at * 1000
      : undefined,
  };
}
