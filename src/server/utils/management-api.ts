/**
 * Management API client leaf (Node Sidecar → Rust loopback) + Team Hub
 * intervention primitives (PRD 0.2.36 §6.3/§6.5).
 *
 * WHY THIS EXISTS
 * ---------------
 * `managementApi()` historically lived as a private helper in admin-api.ts.
 * The §6.5 canUseTool escalation shell in agent-session.ts needs the same
 * loopback channel (resolve remoteTaskId, create/poll interventions), but
 * admin-api.ts statically imports agent-session.ts — importing admin-api back
 * from agent-session closes an ESM cycle (dependency-cruiser `no-circular`,
 * init-order surprises at module-eval time). Per the repo convention ("extract
 * the shared interface into a third leaf module both sides can depend on"),
 * the helper moves HERE: this module imports only other leaves
 * (cancellation / loopback-response), never agent-session or admin-api.
 *
 * admin-api.ts re-imports `managementApi` / `resolveRemoteTaskIdForSession`
 * from here, so its 30+ handlers keep byte-identical behavior.
 */

import { cancellableFetch } from './cancellation';
import { readLoopbackJson } from './loopback-response';

const MGMT_PORT = process.env.ZHISHI_MANAGEMENT_PORT;

/** Same budget the admin-api handlers used when this helper lived there. */
const MANAGEMENT_API_TIMEOUT_MS = 10_000;

/**
 * Minimal JSON call to the Rust management API (127.0.0.1, random port from
 * `ZHISHI_MANAGEMENT_PORT`). Never throws: transport/availability failures
 * come back as `{ ok: false, error, recoveryHint }` so callers can propagate
 * or fail closed without try/catch gymnastics.
 */
export async function managementApi(
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!MGMT_PORT) {
    // Happens when the Node Sidecar is up but the Rust-side Management API
    // isn't — during app cold boot, after a crashed restart, or in the
    // standalone dev sidecar used for CLI smoke tests. Returning the hint
    // alongside the error lets `wrapMgmtResponse` propagate it to the CLI
    // so the reader sees `→ Run: zhishi status` instead of a dead-end.
    return {
      ok: false,
      error: 'Management API not available (app may still be starting)',
      recoveryHint: {
        recoveryCommand: 'zhishi status',
        message: 'Check whether the app backend is fully up; if not, retry in a few seconds.',
      },
    };
  }
  const url = `http://127.0.0.1:${MGMT_PORT}${path}`;
  const options: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body && method === 'POST') {
    options.body = JSON.stringify(body);
  }
  try {
    const resp = await cancellableFetch(url, options, { timeoutMs: MANAGEMENT_API_TIMEOUT_MS });
    // Issue #114 — defensive read via shared helper.
    return await readLoopbackJson(resp, 'Management API');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Management API unreachable: ${msg}`,
      recoveryHint: {
        recoveryCommand: 'zhishi status',
        message: 'Check backend health; restart the app if the problem persists.',
      },
    };
  }
}
