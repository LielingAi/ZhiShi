/**
 * MCP OAuth Discovery
 *
 * Implements:
 * - RFC 9728: Protected Resource Metadata
 * - RFC 8414: Authorization Server Metadata
 *
 * Two-step discovery:
 *   1. GET {mcpUrl}/.well-known/oauth-protected-resource → auth server URL
 *   2. GET {authServer}/.well-known/oauth-authorization-server → endpoints
 *
 * Fallback: If step 1 fails, try step 2 directly on mcpUrl.
 */

import type { OAuthServerMetadata, DiscoveryCache } from './types';

const TIMEOUT_MS = 10000;

/**
 * Discover the OAuth authorization server for an MCP resource (RFC 9728).
 * Returns the auth server URL(s) or null if not a protected resource.
 */
async function discoverProtectedResource(
  mcpUrl: string,
): Promise<{ authorizationServers: string[]; scopes?: string[] } | null> {
  const url = new URL(mcpUrl);
  const baseUrl = `${url.protocol}//${url.host}`;
  const wellKnown = `${baseUrl}/.well-known/oauth-protected-resource`;

  try {
    const res = await fetch(wellKnown, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;

    const data = await res.json() as {
      resource?: string;
      authorization_servers?: string[];
      scopes_supported?: string[];
    };

    if (data.authorization_servers?.length) {
      console.log(`[mcp-oauth] Protected Resource Metadata found: auth servers = ${data.authorization_servers.join(', ')}`);
      return {
        authorizationServers: data.authorization_servers,
        scopes: data.scopes_supported,
      };
    }
  } catch {
    // Not available — not a fatal error
  }

  return null;
}

/**
 * Discover OAuth Authorization Server Metadata (RFC 8414).
 * Returns the full metadata including endpoints.
 */
async function discoverAuthServerMetadata(
  authServerUrl: string,
): Promise<OAuthServerMetadata | null> {
  const url = new URL(authServerUrl);
  const baseUrl = `${url.protocol}//${url.host}`;
  const wellKnown = `${baseUrl}/.well-known/oauth-authorization-server`;

  try {
    const res = await fetch(wellKnown, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;

    const metadata = await res.json() as OAuthServerMetadata;
    if (metadata.authorization_endpoint && metadata.token_endpoint) {
      console.log(`[mcp-oauth] Auth Server Metadata found at ${wellKnown}`);
      return metadata;
    }
  } catch {
    // Not available
  }

  return null;
}

/**
 * Full OAuth discovery flow for an MCP server.
 *
 * 1. Try Protected Resource Metadata → get auth server URL
 * 2. Fetch Auth Server Metadata from that URL
 * 3. Fallback: try Auth Server Metadata directly on mcpUrl
 *
 * Returns null if the server does not require OAuth.
 */
export async function discoverOAuth(mcpUrl: string): Promise<DiscoveryCache | null> {
  // Step 1: Protected Resource Metadata
  const prm = await discoverProtectedResource(mcpUrl);
  const authServerUrl = prm?.authorizationServers?.[0];

  // Step 2: Auth Server Metadata (prefer PRM-specified server, fallback to mcpUrl)
  const targetUrl = authServerUrl || mcpUrl;
  const metadata = await discoverAuthServerMetadata(targetUrl);

  if (!metadata) {
    // Last resort: try mcpUrl directly if we had an authServerUrl from PRM
    if (authServerUrl) {
      const fallback = await discoverAuthServerMetadata(mcpUrl);
      if (fallback) {
        return {
          authServerUrl: mcpUrl,
          authorizationEndpoint: fallback.authorization_endpoint,
          tokenEndpoint: fallback.token_endpoint,
          registrationEndpoint: fallback.registration_endpoint,
          scopesSupported: prm?.scopes ?? fallback.scopes_supported,
          discoveredAt: Date.now(),
        };
      }
    }
    return null;
  }

  return {
    authServerUrl: authServerUrl || mcpUrl,
    authorizationEndpoint: metadata.authorization_endpoint,
    tokenEndpoint: metadata.token_endpoint,
    registrationEndpoint: metadata.registration_endpoint,
    scopesSupported: prm?.scopes ?? metadata.scopes_supported,
    discoveredAt: Date.now(),
  };
}
