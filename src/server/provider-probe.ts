/**
 * Provider verification — Layer 1 (authenticated direct probe) + shared pure
 * helpers for diagnostic surfacing.
 *
 * Background (PRD 0.2.30 `provider_verify_error_surfacing`): provider API-key
 * verification spawns a full SDK subprocess with a single 30s timeout. Every
 * "reachable but failing" case (wrong baseUrl path, missing model, balance,
 * hang, proxy mismatch) collapsed into ONE detail-less, misleading message —
 * `验证超时，请检查网络连接`. Layer 1 hits the real endpoint BEFORE the SDK to
 * read the provider's actual status+body, so the real reason is visible.
 *
 * Per-protocol fidelity (codex review — the SDK's egress path forks by protocol;
 * see agent-session.ts:4410 / :4462):
 *   - OpenAI: SDK → loopback bridge (proxy vars stripped); bridge owns upstream
 *     proxy via undici. A loopback probe through the SAME one-shot bridge is
 *     byte-equivalent to real usage → AUTHORITATIVE, may short-circuit.
 *   - Anthropic: SDK native binary hits baseUrl DIRECTLY with its own proxy
 *     semantics (CLI ignores no_proxy; undici honors it). A Node probe is a
 *     DIFFERENT network stack → DIAGNOSTIC-ONLY, never short-circuits / never
 *     flips the verdict; its result only enriches `detail`.
 *
 * The pure functions here carry no I/O and are unit-tested in the fast pool
 * (`provider-probe.unit.test.ts`).
 */

import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici';
import { withAbortSignal } from './utils/cancellation';
import type { ProviderEnv } from './agent-session';

const PROBE_TIMEOUT_MS = 15000;
const PROBE_BODY_MAX = 500;
const ANTHROPIC_VERSION = '2023-06-01';

/** Result of a single Layer-1 probe attempt. */
export interface ProbeOutcome {
  /** HTTP status the probe received (bridge-translated for OpenAI). */
  status?: number;
  /** Truncated response body (provider's own error text lives here). */
  body?: string;
  /** Connection-layer failure message (DNS / TLS / refused) when the fetch threw. */
  connectError?: string;
  /** The probe's own timeout fired before any response — inconclusive. */
  timedOut?: boolean;
}

// ---------------------------------------------------------------------------
// Pure helpers (no I/O — unit-tested)
// ---------------------------------------------------------------------------

/** Structured error result with a human-friendly summary + raw detail for diagnosis. */
export interface VerifyError {
  error: string;
  detail?: string;
}

/**
 * Bucket a provider API-key verification error into a human-friendly summary,
 * keeping the raw text in `detail`. `errorText` may be lowercased by the caller;
 * `originalText` preserves original casing for the detail popover.
 */
export function parseProviderError(errorText: string, originalText?: string): VerifyError {
  const raw = (originalText ?? errorText).slice(0, 300) || undefined;
  const lower = errorText.toLowerCase();
  if (lower.includes('authentication') || lower.includes('unauthorized') || lower.includes('401')) {
    return { error: 'API Key 无效或已过期', detail: raw };
  } else if (lower.includes('forbidden') || lower.includes('403')) {
    return { error: '访问被拒绝，请检查 API Key 权限', detail: raw };
  } else if (
    // 402 bucket: the OpenAI bridge remaps quota/billing 429 → 402 so it surfaces
    // immediately (openai-bridge/translate/errors.ts isQuotaExhausted). Match the
    // common balance/quota phrasings too so direct-protocol providers bucket here.
    lower.includes('402') || lower.includes('payment required')
    || lower.includes('insufficient') || lower.includes('quota')
    || lower.includes('balance') || lower.includes('欠费') || lower.includes('余额')
  ) {
    return { error: '余额不足或账户欠费，请检查供应商账户', detail: raw };
  } else if (lower.includes('rate limit') || lower.includes('429')) {
    return { error: '请求频率限制，请稍后再试', detail: raw };
  } else if (lower.includes('network') || lower.includes('connect') || lower.includes('econnrefused')) {
    return { error: '网络连接失败，请检查 Base URL', detail: raw };
  } else if (lower.includes('not found') || lower.includes('404')) {
    return { error: '模型不存在或 API 地址错误', detail: raw };
  }
  return { error: errorText.slice(0, 100) || '验证失败', detail: raw };
}

/**
 * Replicate the Anthropic SDK's URL construction for the `/v1/messages` path,
 * so the Anthropic diagnostic probe hits the EXACT url the SDK hits.
 *
 * Source of truth — `node_modules/@anthropic-ai/sdk/client.mjs` `buildURL`:
 *   new URL(baseURL + (baseURL.endsWith('/') && path.startsWith('/') ? path.slice(1) : path))
 * with path = '/v1/messages'.
 *
 * This is NOT URL normalization: a misconfigured baseUrl ending in `/v1`
 * intentionally yields `/v1/v1/messages` (the same 404 the SDK would hit),
 * because surfacing that 404 is the whole diagnostic point. Do NOT dedupe `/v1`.
 */
export function joinAnthropicMessagesUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? `${baseUrl}v1/messages` : `${baseUrl}/v1/messages`;
}

/** Map provider authType → the headers the Anthropic SDK would send (agent-session.ts:4471+). */
export function anthropicAuthHeaders(
  authType: ProviderEnv['authType'] | undefined,
  apiKey: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
  };
  switch (authType ?? 'both') {
    case 'api_key':
      headers['x-api-key'] = apiKey;
      break;
    case 'auth_token_clear_api_key':
      headers['authorization'] = `Bearer ${apiKey}`;
      break;
    case 'auth_token':
    case 'both':
    default:
      headers['x-api-key'] = apiKey;
      headers['authorization'] = `Bearer ${apiKey}`;
      break;
  }
  return headers;
}

/** One-line summary of a probe outcome for the `detail` popover. */
export function summarizeProbeOutcome(outcome: ProbeOutcome | undefined): string | undefined {
  if (!outcome) return undefined;
  if (outcome.timedOut) return `探测超时（${PROBE_TIMEOUT_MS / 1000}s 未响应，未定论）`;
  if (outcome.connectError) return `连接失败：${outcome.connectError.slice(0, 200)}`;
  if (outcome.status !== undefined) {
    const body = outcome.body ? ` ${outcome.body.slice(0, PROBE_BODY_MAX)}` : '';
    return `HTTP ${outcome.status}${body}`;
  }
  return undefined;
}

export interface FailureDetailContext {
  baseUrl?: string;
  model?: string;
  apiProtocol?: string;
  elapsedMs?: number;
  stderr?: string[];
  /** Strong-match bridge error (URL + time window confirmed) — authoritative. */
  scopedBridgeError?: string;
  /** In-window bridge error whose attribution is NOT confirmed — weak signal. */
  weakBridgeError?: string;
  /** Anthropic diagnostic-probe summary (non-authoritative). */
  diagnostic?: string;
}

/**
 * Compose the always-present `detail` string for a verify failure. The whole
 * point of P0 is that this is NEVER empty, so the frontend "详情" button always
 * renders and the user's screenshot carries baseUrl + model at minimum.
 */
export function composeVerifyFailureDetail(ctx: FailureDetailContext): string {
  const lines: string[] = [];
  if (ctx.baseUrl) lines.push(`baseUrl: ${ctx.baseUrl}`);
  // Omit the model line when unset (default provider verify has no model) to avoid
  // a meaningless "model: (default)" in its timeout detail.
  if (ctx.model) lines.push(`model: ${ctx.model}`);
  if (ctx.apiProtocol) lines.push(`protocol: ${ctx.apiProtocol}`);
  if (ctx.elapsedMs !== undefined) lines.push(`elapsed: ${ctx.elapsedMs}ms`);

  const stderrText = ctx.stderr && ctx.stderr.length > 0
    ? ctx.stderr.join('; ').slice(0, 300)
    : '无 stderr 输出';
  lines.push(`stderr: ${stderrText}`);

  if (ctx.scopedBridgeError) {
    lines.push(`bridge: ${ctx.scopedBridgeError.slice(0, 300)}`);
  } else if (ctx.weakBridgeError) {
    lines.push(`bridge(可能相关, 未确认归属): ${ctx.weakBridgeError.slice(0, 300)}`);
  }
  if (ctx.diagnostic) lines.push(`诊断探测: ${ctx.diagnostic}`);
  return lines.join('\n');
}

/** Honest lead message for the timeout / no-result branches (no more false "请检查网络连接"). */
export function verifyTimeoutMessage(opts: {
  reason: 'timeout' | 'no_result';
  hasProviderContext: boolean;
  scopedBridgeError?: string;
  timeoutMs?: number;
}): string {
  if (opts.scopedBridgeError) {
    return `无法连接到供应商：${opts.scopedBridgeError}`;
  }
  const seconds = Math.round((opts.timeoutMs ?? PROBE_TIMEOUT_MS * 2) / 1000);
  if (opts.reason === 'timeout') {
    return opts.hasProviderContext
      ? `供应商在 ${seconds} 秒内未响应——可能是模型不存在 / 供应商过载 / API Key 受限，与本地网络无关（点"详情"看探测结果）`
      : '验证超时，请检查网络连接';
  }
  // no_result
  return opts.hasProviderContext
    ? '验证未返回结果——供应商可能返回了无法解析的响应（点"详情"看探测结果）'
    : '验证未返回结果';
}

// ---------------------------------------------------------------------------
// Impure probes (Layer 1)
// ---------------------------------------------------------------------------

/**
 * Anthropic Layer-1 probe — DIAGNOSTIC ONLY. Hits the provider's `/v1/messages`
 * directly (proxy-aware via utils/proxy-for-url). Its result NEVER
 * flips the verdict and NEVER short-circuits — it only enriches `detail`. The
 * Node `undici` stack can diverge from the SDK native binary on proxy/TLS, so
 * the caller MUST label this as a diagnostic with possible proxy differences.
 */
export async function probeAnthropicProviderDirect(args: {
  providerEnv: ProviderEnv;
  model: string | undefined;
  getProxyForUrl: (url: string) => string | undefined;
  signal?: AbortSignal;
}): Promise<ProbeOutcome> {
  const { providerEnv, model, getProxyForUrl, signal } = args;
  const baseUrl = providerEnv.baseUrl;
  if (!baseUrl) return { connectError: 'no baseUrl' };
  const url = joinAnthropicMessagesUrl(baseUrl);
  // One-shot ProxyAgent — closed in finally so repeated failing verifies under a
  // proxy don't leak dispatcher connection pools (the bridge caches its agents
  // for the same reason; verify is infrequent enough to not need the cache).
  let agent: ProxyAgent | undefined;
  try {
    return await withAbortSignal(
      signal,
      async (probeSignal): Promise<ProbeOutcome> => {
        const proxyUrl = getProxyForUrl(url);
        const init: Parameters<typeof undiciFetch>[1] & { dispatcher?: Dispatcher } = {
          method: 'POST',
          headers: anthropicAuthHeaders(providerEnv.authType, providerEnv.apiKey ?? ''),
          body: JSON.stringify({
            model: model ?? 'probe',
            max_tokens: 1,
            messages: [{ role: 'user', content: '1' }],
          }),
          signal: probeSignal,
          // Don't follow redirects (review #1): a legit-looking https baseUrl
          // that 302s to an internal address would otherwise let this probe
          // reach intranet/metadata endpoints and reflect the body into `detail`.
          // We deliberately do NOT scheme/private-net-block the baseUrl itself
          // (unlike downloadAndSaveUrl's prompt-controlled URLs): the provider
          // baseUrl is USER-CONFIGURED settings and legitimately points at
          // localhost / LAN for self-hosted models (Ollama, LM Studio, vLLM,
          // local Anthropic-compatible proxies). Blocking those would break
          // verification for a config the SDK connects to anyway in normal use —
          // the probe is byte-equivalent to that real connection. Refusing
          // redirects closes the one vector (host says https, hops internal)
          // without that regression; it's diagnostic-only so a refused redirect
          // just yields less detail, never a false verdict.
          redirect: 'error',
        };
        if (proxyUrl) {
          agent = new ProxyAgent(proxyUrl);
          init.dispatcher = agent;
        }
        const resp = await undiciFetch(url, init);
        const body = (await resp.text()).slice(0, PROBE_BODY_MAX);
        return { status: resp.status, body };
      },
      { timeoutMs: PROBE_TIMEOUT_MS },
    );
  } catch (err) {
    return toProbeError(err);
  } finally {
    if (agent) { try { await agent.close(); } catch { /* already closed */ } }
  }
}

/** Normalize a thrown fetch error into a ProbeOutcome (timeout vs connect failure). */
function toProbeError(err: unknown): ProbeOutcome {
  const isAbort = err instanceof Error && err.name === 'AbortError';
  if (isAbort) return { timedOut: true };
  // undici wraps the real reason on `.cause`.
  const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
  const causeMsg = cause instanceof Error ? cause.message : cause ? String(cause) : '';
  const baseMsg = err instanceof Error ? err.message : String(err);
  return { connectError: causeMsg ? `${baseMsg} (cause: ${causeMsg})` : baseMsg };
}
