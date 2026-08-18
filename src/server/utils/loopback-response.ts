/**
 * Defensive JSON parsing for local loopback HTTP responses.
 *
 * Issue #114 — Axum's `Json<T>` extractor returns `422 + text/plain` when the
 * request body fails to deserialize (missing field, type mismatch, etc.).
 * Calling `resp.json()` blindly throws SyntaxError, which surfaces to users
 * (and AI agents) as cryptic "Unexpected token 'F'" errors.
 *
 * This helper reads the body once as text, then dispatches based on
 * `resp.ok` + `Content-Type`. The four call sites it replaces (admin-api's
 * `managementApi` + `sidecarSelf`) all want the same behaviour: return parsed JSON on
 * success, surface the actual server text on failure, never throw.
 */

// Plain Record-shaped envelope so callers that already type their downstream
// as `Record<string, unknown>` can consume the result without a cast. Using
// an interface with a string index signature here would force `unknown` value
// inference on every legitimate field; the documented shape is just `ok` +
// `error`, but consumers don't need a stricter contract.
export type LoopbackParseError = Record<string, unknown> & { ok: false; error: string };

const TEXT_TRUNCATE = 500;
const MALFORMED_JSON_TRUNCATE = 300;

/**
 * Read and interpret a `fetch` response from a local loopback API.
 *
 * @param resp - the awaited Response
 * @param label - short tag for the API surface (e.g. "Management API",
 *   "Sidecar self-call", "Bridge /mcp/tools"); appears in error messages
 *   so the reader can tell which hop in the chain returned non-JSON.
 *
 * Returns either the parsed JSON object or `{ ok: false, error }` describing
 * why parsing failed (non-2xx status, non-JSON content-type, malformed JSON).
 */
export async function readLoopbackJson(
  resp: Response,
  label: string,
): Promise<Record<string, unknown> | LoopbackParseError> {
  const bodyText = await resp.text();
  const contentType = resp.headers.get('content-type') ?? '';

  if (resp.ok && contentType.includes('application/json')) {
    try {
      return JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      return {
        ok: false,
        error: `${label} returned malformed JSON: ${bodyText.slice(0, MALFORMED_JSON_TRUNCATE)}`,
      };
    }
  }

  // Non-OK or non-JSON. Axum's default extractor rejection lands here as
  // 4xx text/plain; we want to surface the actual server text so the
  // reader sees "missing field 'taskId'" instead of "Unexpected token 'F'".
  const trimmed = bodyText.trim().slice(0, TEXT_TRUNCATE);
  const statusPart = `${resp.status}${resp.statusText ? ' ' + resp.statusText : ''}`;
  return {
    ok: false,
    error: `${label} ${statusPart}${trimmed ? ': ' + trimmed : ''}`,
  };
}
