/**

 * Provider verification utilities

 * Verifies API key validity by sending a test request

 */



import { execSync } from 'child_process';

import { type ProviderEnv } from './agent-session';

import { oneShotResult } from './loop/one-shot';

import { resolveLoopModelFromEnv } from './loop/pi-provider';

import { getProxyForUrl } from './utils/proxy-for-url';

import {

  probeAnthropicProviderDirect,

  composeVerifyFailureDetail,

  verifyTimeoutMessage,

  summarizeProbeOutcome,

  parseProviderError,

  type VerifyError,

  type ProbeOutcome,

} from './provider-probe';



/**

 * Shared verification core (M1: pi one-shot — 原 SDK 子进程路径已退役).

 * 对目标 provider 发一条平凡的测试请求，返回 success/failure。

 * 无子进程、无 bridge 回环（OpenAI 协议由 pi 原生支持）；上游错误文本

 * 经 opts.parseError 分类，与原 SDK assistant-error 分支语义一致。

 */

async function verifyViaSdk(

  providerEnv: ProviderEnv,

  opts: {

    model?: string;

    logPrefix: string;

    parseError: (text: string, originalText?: string) => VerifyError;

    /**

     * Real upstream baseUrl this verify targets (user-config baseUrl, NOT the

     * loopback ANTHROPIC_BASE_URL we set for OpenAI-bridge mode). Used to

     * scope bridge-error diagnostics so a concurrent verify of a DIFFERENT

     * provider can't leak its error into this one's timeout message.

     */

    upstreamBaseUrlForDiagnostics?: string;

    /**

     * Provider context for the always-present `detail` (PRD 0.2.30 P0). When

     * `baseUrl` is set the timeout/no-result copy switches to the honest

     * "supplier didn't respond" wording instead of the misleading

     * "check your network". Absent when verifying the default provider.

     */

    detailContext?: { baseUrl?: string; apiProtocol?: string };

    /**

     * Anthropic Layer-1 diagnostic (PRD 0.2.30 P1). Started CONCURRENTLY with

     * the SDK (so it never extends the 30s timeout) and consumed only by the

     * timeout / no-result branches to enrich `detail` with the provider's real

     * status+body. Diagnostic-only: it never flips the verdict. Absent for

     * OpenAI (covered by the authoritative pre-probe). The

     * passed signal is aborted once verify settles so a still-in-flight probe

     * (fast-success case) doesn't outlive the call.

     */

    diagnostic?: (signal: AbortSignal) => Promise<ProbeOutcome | undefined>;

  },

): Promise<{ success: boolean; error?: string; detail?: string }> {

  const TIMEOUT_MS = 30000;

  const startTime = Date.now();

  const stderrMessages: string[] = [];



  // Kick off the diagnostic in parallel with the SDK. It has its own ≤15s cap

  // (withAbortSignal) so it's resolved well before the 30s timeout — the

  // timeout branch reads it without blocking. `diagController` cancels it when

  // verify settles first (e.g. fast success) so it never leaks past the call.

  const diagController = new AbortController();

  const diagnosticPromise = opts.diagnostic

    ? opts.diagnostic(diagController.signal).catch(() => undefined)

    : undefined;



  // Compose the structured failure result shared by the timeout + no-result

  // branches: gather bridge signals (strong/weak), consume the already-running

  // diagnostic (started concurrently above), and build an always-present

  // `detail` via the pure composers.

  const buildTimeoutLikeFailure = async (

    reason: 'timeout' | 'no_result',

  ): Promise<{ success: false; error: string; detail: string }> => {

    // M4c: openai-bridge 已删除——bridge 错误信号源不复存在,此分支整体

    // 退役(原 scopedBridgeError/weakBridgeError 诊断)。composeVerifyFailureDetail

    // 的两个字段传 undefined 即缺省。

    const scopedBridgeError: string | undefined = undefined;

    const weakBridgeError: string | undefined = undefined;

    // Consume the already-running diagnostic (started at call entry). It's

    // resolved by now (≤15s cap, the timeout is 30s), so this never blocks.

    let diagnostic: string | undefined;

    if (diagnosticPromise) {

      const summary = summarizeProbeOutcome(await diagnosticPromise);

      if (summary) diagnostic = `${summary}（诊断探测，可能与 SDK 实际出网存在代理差异）`;

    }



    const detail = composeVerifyFailureDetail({

      baseUrl: opts.detailContext?.baseUrl,

      model: opts.model,

      apiProtocol: opts.detailContext?.apiProtocol,

      elapsedMs: Date.now() - startTime,

      stderr: stderrMessages,

      scopedBridgeError,

      weakBridgeError,

      diagnostic,

    });

    const error = verifyTimeoutMessage({

      reason,

      hasProviderContext: !!opts.detailContext?.baseUrl,

      scopedBridgeError,

      timeoutMs: TIMEOUT_MS,

    });

    return { success: false, error, detail };

  };

  // Collect the first real API error seen during the verify window.

  // If the SDK retries internally (e.g. 429) and our timeout fires first,

  // we use this instead of the generic "验证超时" message.

  let firstAuthError: VerifyError | undefined;

  const { logPrefix, parseError } = opts;



  try {

    // M1: pi one-shot 替换 SDK 子进程。无 CLI 路径/cwd/bridge env；

    // thinking 由 pi 按模型目录自行处理（第三方 provider 的 thinking 400

    // 兼容问题由 pi 的 thinkingLevelMap/compat 层负责，不在此特判）。

    const resolution = opts.model

      ? resolveLoopModelFromEnv(providerEnv, opts.model)

      : null;

    if (!resolution) {

      const parsed = parseError('missing model or api key for provider verify');

      return { success: false, ...parsed };

    }

    // 真实中断句柄（替代原 SDK 迭代器 return() 释放子进程的 cleanup）。

    const callController = new AbortController();

    const verifyPromise = (async (): Promise<{ success: boolean; error?: string; detail?: string }> => {

      const result = await oneShotResult({

        prompt: 'It\'s a test, directly reply "1"',

        model: resolution.model,

        models: resolution.models,

        apiKey: resolution.getApiKey(),

        signal: callController.signal,

      });

      if (result.ok) {

        const elapsed = Date.now() - startTime;

        console.log(`[${logPrefix}] verification successful (${elapsed}ms)`);

        return { success: true };

      }

      // 上游错误（401/403/429/…）——与原 SDK assistant-error 分支同一

      // 分类入口；记录首个错误供超时分支优先使用。

      console.error(`[${logPrefix}] auth error: ${result.error}`);

      const parsed = parseError(result.error.toLowerCase(), result.error);

      if (!firstAuthError) firstAuthError = parsed;

      return { success: false, ...parsed };

    })();



    const cleanupQuery = () => {

      callController.abort();

    };


    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<{ success: false; error: string; detail?: string }>((resolve) => {

      timeoutId = setTimeout(() => {

        // Priority: real API error collected (already has detail) > composed

        // failure (honest copy + always-present detail: bridge signal, lazy

        // diagnostic, baseUrl/model/elapsed/stderr). See buildTimeoutLikeFailure.

        if (firstAuthError) {

          console.log(`[${logPrefix}] timeout but have auth error collected, using it`);

          resolve({ success: false, error: firstAuthError.error, detail: firstAuthError.detail });

          return;

        }

        void (async () => {

          const failure = await buildTimeoutLikeFailure('timeout');

          console.log(`[${logPrefix}] timeout → ${failure.error}`);

          resolve(failure);

        })();

      }, TIMEOUT_MS);

    });



    try {

      return await Promise.race([verifyPromise, timeoutPromise]);

    } finally {

      if (timeoutId) clearTimeout(timeoutId);

      cleanupQuery();

      // Cancel a still-in-flight diagnostic (e.g. fast-success path) so it

      // never outlives the verify call.

      diagController.abort();

    }

  } catch (error) {

    diagController.abort();

    const errorMsg = error instanceof Error ? error.message : String(error);

    console.error(`[${logPrefix}] SDK exception: ${errorMsg}`);

    const parsed = parseError(errorMsg);

    const stderrHint = stderrMessages.length > 0

      ? ` (详情: ${stderrMessages.join('; ').slice(0, 200)})`

      : '';

    return { success: false, error: parsed.error + stderrHint, detail: parsed.detail };

  }

}



/**

 * Verify a provider API key (M1: pi one-shot 直连上游).

 * 打一条真实的模型请求（与正式调用同 provider/模型），verification = real usage。

 */

export async function verifyProviderViaSdk(

  baseUrl: string,

  apiKey: string,

  authType: string,

  model?: string,

  apiProtocol?: 'anthropic' | 'openai',

  maxOutputTokens?: number,

  maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens',

  upstreamFormat?: 'chat_completions' | 'responses',

): Promise<{ success: boolean; error?: string; detail?: string }> {

  console.log(`[provider/verify] Starting SDK verification for ${baseUrl}, model=${model ?? 'default'}, authType=${authType}, apiProtocol=${apiProtocol ?? 'anthropic'}, maxOutputTokens=${maxOutputTokens ?? 'none'}`);

  // PRD #124: register a per-call bridge token so the verify subprocess

  // routes to ITS upstream via /bridge/<token>/v1/messages, completely

  // isolated from the active Chat session's bridge (if any). The token

  // resolver returns a static snapshot — verify's config doesn't change

  // mid-call. Released in finally so the registry stays clean even on

  // throw / timeout.

  const providerEnv: import('./agent-session').ProviderEnv = {

    baseUrl,

    apiKey,

    authType: authType as 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key',

    apiProtocol,

    maxOutputTokens,

    maxOutputTokensParamName,

    upstreamFormat,

  };

  // M4c: openai-bridge 已删除,原 OpenAI Layer-1 bridge 预探整体退役。

  // OpenAI 协议 provider 由 pi 原生直连(verifyViaSdk 的 pi one-shot 即

  // 权威判定);直连诊断探针(probeAnthropicProviderDirect)保留。

  return await verifyViaSdk(providerEnv, {


    model,

    logPrefix: 'provider/verify',

    parseError: parseProviderError,

    // Scope bridge-error diagnostics to this provider's real upstream — but

    // ONLY when the OpenAI bridge is actually in play. Anthropic-protocol

    // providers call their baseUrl directly (no bridge), so any bridge error

    // in the window belongs to some OTHER concurrent session, not us. See

    // verifyViaSdk.opts.upstreamBaseUrlForDiagnostics docstring.

    upstreamBaseUrlForDiagnostics: apiProtocol === 'openai' ? baseUrl : undefined,

    detailContext: { baseUrl, apiProtocol: apiProtocol ?? 'anthropic' },

    // Anthropic-protocol only: a DIAGNOSTIC-ONLY direct probe. Started

    // CONCURRENTLY with the SDK at call entry (verifyViaSdk), but CONSUMED

    // only by the timeout/no-result branch to enrich `detail` with the

    // provider's real status+body. Never flips the verdict (Node undici ≠ SDK

    // native binary on proxy semantics). OpenAI is already covered by the

    // authoritative pre-probe.

    diagnostic: apiProtocol === 'openai'

      ? undefined

      : (signal) => probeAnthropicProviderDirect({ providerEnv, model, getProxyForUrl, signal }),

  });

}



/**

 * Get the current git branch for a directory

 * Returns undefined if not a git repository

 */

export function getGitBranch(cwd: string): string | undefined {

  try {

    const branch = execSync('git rev-parse --abbrev-ref HEAD', {

      cwd,

      encoding: 'utf-8',

      stdio: ['pipe', 'pipe', 'pipe'], // Suppress stderr

    });

    return branch.trim() || undefined;

  } catch {

    // Not a git repository or git not available

    return undefined;

  }

}

