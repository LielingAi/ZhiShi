// Session cron context — sidecar-side state for regular (non-IM) cron sessions.
//
// Historical note: this lived in the retired `im-cron-tool.ts` alongside the
// IM cron context. The IM side was removed in the security-researcher CLI
// transition; what remains is the session-scoped registry downstream code
// reads to know "which session/workspace am I tied to?" when creating or
// managing scheduled tasks. It stays a sidecar-process singleton because
// each Sidecar maps 1:1 to a Session (see ARCHITECTURE «Sidecar Owner 模型»).

import type { RuntimeConfig, RuntimeType } from '../../shared/types/runtime';

export interface SessionCronContext {
  sessionId: string;
  workspacePath: string;
  model?: string;
  permissionMode?: string;
  /** PRD 0.2.9 — DEPRECATED. New code SHOULD pass `providerId` so cron
   *  ticks live-resolve credentials from `~/.zhishi/config.json` and
   *  rotation propagates. Kept for legacy callers. */
  providerEnv?: { baseUrl?: string; apiKey?: string; authType?: 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key'; apiProtocol?: 'anthropic' | 'openai'; maxOutputTokens?: number; maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens'; upstreamFormat?: 'chat_completions' | 'responses' };
  /** PRD 0.2.9 — Per-session provider id; preferred over providerEnv. */
  providerId?: string;
  runtime?: RuntimeType;
  runtimeConfig?: RuntimeConfig;
}

let sessionCronContext: SessionCronContext | null = null;

export function setSessionCronContext(ctx: SessionCronContext): void {
  sessionCronContext = ctx;
  console.log(`[cron] Session cron context set: sessionId=${ctx.sessionId}`);
}

export function clearSessionCronContext(): void {
  sessionCronContext = null;
  console.log('[cron] Session cron context cleared');
}

export function getSessionCronContext(): SessionCronContext | null {
  return sessionCronContext;
}
