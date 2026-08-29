// ============= SESSION API =============
// Extracted from index.ts (1.1.7 ③ god-file strangler split — pure move).
// The /sessions* route branches (plus /api/generate-session-title) lived inside
// main()'s request handler; they are now standalone handlers. The only
// index-module-scope values they captured were `jsonResponse`, `pathname` and
// `url` (all passed in as params) plus the three session-metadata helpers
// below (moved here — nothing outside the session routes used them).

import {
  createSession,
  deleteSession,
  getAllSessionMetadata,
  getSessionData,
  getSessionMetadata,
  getSessionsByAgentDir,
  isDesktopSessionSource,
  updateSessionMetadata,
} from '../SessionStore';

import { findAgentByWorkspacePath } from '../utils/admin-config';

import { findEnvKeyForLoopSession, loadEnvSessionsMap } from '../environment/env-sessions';

import { snapshotForOwnedSession } from '../utils/session-snapshot';

import { resolveLastRealUserMessagePreview, shrinkSessionMessagesForClient } from '../utils/session-message-preview';

import { VALID_RUNTIMES } from '../../shared/types/runtime';

import { getSessionId, type ProviderEnv } from '../agent-session';

import { forkPiChat, getPiMessages, switchPiSession } from '../loop/chat-engine';

import type { AgentConfig } from '../../shared/types/agent';

import type { SessionMetadata } from '../types/session';

import type { JsonResponseFn } from '../cron/routes';

/**

 * Strip credential-bearing fields from a SessionMetadata before returning to clients.

 * Replaces providerEnvJson with '[redacted]' when present (so the client can still tell

 * a provider override exists without seeing the raw API key). Used by GET /sessions,

 * GET /sessions/:id, and PATCH /sessions/:id response shapes — zero-trust parity.

 */

function redactSessionMetadata<T extends { providerEnvJson?: string }>(meta: T): T {

  if (meta.providerEnvJson === undefined) return meta;

  return { ...meta, providerEnvJson: '[redacted]' };

}



function isGenericSessionTitle(title: string | undefined): boolean {

  const trimmed = (title ?? '').trim();

  return trimmed === '' || trimmed === 'New Chat' || trimmed === 'New Tab';

}



function normalizeSessionListPreview(meta: SessionMetadata): SessionMetadata {

  if (!isGenericSessionTitle(meta.title)) return meta;

  if (!meta.runtime || meta.runtime === 'builtin') return meta;



  const data = getSessionData(meta.id);

  const resolved = data

    ? resolveLastRealUserMessagePreview(data.messages)

    : { found: false as const };

  if (resolved.found) {

    return { ...meta, lastMessagePreview: resolved.preview };

  }



  // v0.2.22 external runtimes stored assistant text in lastMessagePreview.

  // For generic-title rows that have no real user preview, prefer "New Chat"

  // over carrying that stale assistant snippet into every list surface.

  if (meta.lastMessagePreview) {

    return { ...meta, lastMessagePreview: undefined };

  }



  return meta;

}



export async function handleForkSession(request: Request, jsonResponse: JsonResponseFn): Promise<Response> {

        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

        const messageId = typeof body.messageId === 'string' ? body.messageId : '';

        if (!messageId) {

          return jsonResponse({ success: false, error: 'Missing messageId' }, 400);

        }

        // pi 引擎:fork 已实现(forkPiChat——复制前半段到新 loop session,
        // 当前 loop 原地换血)。

        return jsonResponse(await forkPiChat(messageId));

}

export async function handleListSessions(url: URL, jsonResponse: JsonResponseFn): Promise<Response> {

        try {

          const agentDirParam = url.searchParams.get('agentDir');

          const sessions = agentDirParam

            ? getSessionsByAgentDir(agentDirParam)

            : getAllSessionMetadata().filter(s => isDesktopSessionSource(s.source));

          // Zero-trust: strip providerEnvJson before handing to clients.

          // Matches PATCH response behavior (see PATCH /sessions/:id).

          // 1.3.3 历史面板:按 env-sessions 分线映射给每行补 envKey(additive,
          // 无 loopSessionId / 无映射的行不带该字段)——列表按 env 分组的数据源。

          const envMap = loadEnvSessionsMap();

          const safeSessions = sessions

            .map(normalizeSessionListPreview)

            .map((s) => (s.loopSessionId

              ? { ...s, envKey: findEnvKeyForLoopSession(envMap, s.agentDir, s.loopSessionId) ?? undefined }

              : s))

            .map(redactSessionMetadata);

          return jsonResponse({ success: true, sessions: safeSessions });

        } catch (error) {

          console.error('[sessions] Error in GET /sessions:', error);

          return jsonResponse({

            success: false,

            error: error instanceof Error ? error.message : 'Unknown error in SessionStore'

          }, 500);

        }

}

export async function handleCreateSession(request: Request, jsonResponse: JsonResponseFn): Promise<Response> {

        let payload: { agentDir: string; runtime?: string; scenario?: string };

        try {

          payload = (await request.json()) as { agentDir: string; runtime?: string; scenario?: string };

        } catch {

          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);

        }



        const agentDirValue = payload?.agentDir?.trim();

        if (!agentDirValue) {

          return jsonResponse({ success: false, error: 'agentDir is required.' }, 400);

        }



        // Use the shared VALID_RUNTIMES constant — same list that drives

        // admin-api validation and HELP_TEXTS. A local literal here used to

        // silently drift when new runtimes landed.

        const runtimeValue = (VALID_RUNTIMES as readonly string[]).includes(payload?.runtime as string)

          ? (payload.runtime as import('../../shared/types/runtime').RuntimeType)

          : undefined;

        // v0.1.69 Desktop session = owned snapshot. Capture model/permission/provider

        // from AgentConfig so the session is self-contained from creation onward.

        // D20: a runtime override in the payload is preserved on disk verbatim

        // (config compat) but has no effect — builtin is the only runtime.

        const agent = findAgentByWorkspacePath(agentDirValue) as AgentConfig | undefined;

        const baseSnapshot: Partial<SessionMetadata> = agent ? snapshotForOwnedSession(agent) : {};

        if (runtimeValue) baseSnapshot.runtime = runtimeValue;

        // 安全研究员版 P1 S1 — `zhishi agent` CLI 在 payload 里声明
        // scenario:'security'；落进会话元数据（snapshot），startStreamingSession
        // 每个 turn 按元数据恢复 InteractionScenario（不落全局 currentScenario）。
        // 未知/缺失的 scenario 值静默忽略 = desktop 场景（现状不变）。

        if (payload?.scenario === 'security') baseSnapshot.interactionScenario = 'security';

        const session = await createSession(agentDirValue, baseSnapshot);

        return jsonResponse({ success: true, session });

}

export async function handleGetSessionSince(pathname: string, jsonResponse: JsonResponseFn): Promise<Response> {

        const match = pathname.match(/^\/sessions\/([^/]+)\/since\/([^/]+)$/);

        if (!match) {

          return jsonResponse({ success: false, error: 'Invalid path.' }, 400);

        }

        const sessionId = decodeURIComponent(match[1]);

        const lastMessageId = decodeURIComponent(match[2]);



        const session = getSessionData(sessionId);

        if (!session) {

          return jsonResponse({ success: false, error: 'Session not found.' }, 404);

        }



        const idx = session.messages.findIndex(m => m.id === lastMessageId);

        // idx === -1 signals "caller's baseline is gone" (session was rewound,

        // compacted, or otherwise rewritten). Caller falls back to full reload.

        if (idx === -1) {

          return jsonResponse({ success: true, fromIndex: -1, messages: [] });

        }



        const tail = shrinkSessionMessagesForClient(session.messages.slice(idx + 1));

        // Same metadata-only shape as GET /sessions/:id (P0) — previews are

        // resolved via the zhishi:// custom protocol on the client.

        return jsonResponse({ success: true, fromIndex: idx, messages: tail });

}

export async function handleGetSessionStats(pathname: string, jsonResponse: JsonResponseFn): Promise<Response> {

        const sessionId = pathname.replace('/sessions/', '').replace('/stats', '');

        if (!sessionId) {

          return jsonResponse({ success: false, error: 'Session ID required.' }, 400);

        }



        const session = getSessionData(sessionId);

        if (!session) {

          return jsonResponse({ success: false, error: 'Session not found.' }, 404);

        }



        // Group stats by model

        const byModel: Record<string, {

          inputTokens: number;

          outputTokens: number;

          cacheReadTokens: number;

          cacheCreationTokens: number;

          count: number;

        }> = {};



        // Build message details

        const messageDetails: Array<{

          userQuery: string;

          model?: string;

          inputTokens: number;

          outputTokens: number;

          cacheReadTokens?: number;

          cacheCreationTokens?: number;

          toolCount?: number;

          durationMs?: number;

        }> = [];



        let currentUserQuery = '';

        for (const msg of session.messages) {

          if (msg.role === 'user') {

            currentUserQuery = typeof msg.content === 'string'

              ? msg.content.slice(0, 100)

              : JSON.stringify(msg.content).slice(0, 100);

          } else if (msg.role === 'assistant' && msg.usage) {

            // Use modelUsage for per-model breakdown if available, fallback to single model

            if (msg.usage.modelUsage) {

              for (const [model, stats] of Object.entries(msg.usage.modelUsage)) {

                if (!byModel[model]) {

                  byModel[model] = {

                    inputTokens: 0,

                    outputTokens: 0,

                    cacheReadTokens: 0,

                    cacheCreationTokens: 0,

                    count: 0,

                  };

                }

                byModel[model].inputTokens += stats.inputTokens ?? 0;

                byModel[model].outputTokens += stats.outputTokens ?? 0;

                byModel[model].cacheReadTokens += stats.cacheReadTokens ?? 0;

                byModel[model].cacheCreationTokens += stats.cacheCreationTokens ?? 0;

                byModel[model].count++;

              }

            } else {

              // Fallback for older messages without modelUsage

              const model = msg.usage.model || 'unknown';

              if (!byModel[model]) {

                byModel[model] = {

                  inputTokens: 0,

                  outputTokens: 0,

                  cacheReadTokens: 0,

                  cacheCreationTokens: 0,

                  count: 0,

                };

              }

              byModel[model].inputTokens += msg.usage.inputTokens ?? 0;

              byModel[model].outputTokens += msg.usage.outputTokens ?? 0;

              byModel[model].cacheReadTokens += msg.usage.cacheReadTokens ?? 0;

              byModel[model].cacheCreationTokens += msg.usage.cacheCreationTokens ?? 0;

              byModel[model].count++;

            }



            // Message details always use aggregate values

            messageDetails.push({

              userQuery: currentUserQuery,

              model: msg.usage.model,

              inputTokens: msg.usage.inputTokens ?? 0,

              outputTokens: msg.usage.outputTokens ?? 0,

              cacheReadTokens: msg.usage.cacheReadTokens,

              cacheCreationTokens: msg.usage.cacheCreationTokens,

              toolCount: msg.toolCount,

              durationMs: msg.durationMs,

            });

          }

        }



        const metadata = getSessionMetadata(sessionId);

        return jsonResponse({

          success: true,

          stats: {

            summary: metadata?.stats ?? {

              messageCount: 0,

              totalInputTokens: 0,

              totalOutputTokens: 0,

            },

            byModel,

            messageDetails,

          },

        });

}

export async function handleGetSession(pathname: string, url: URL, jsonResponse: JsonResponseFn): Promise<Response> {

        const sessionId = pathname.replace('/sessions/', '');

        if (!sessionId) {

          return jsonResponse({ success: false, error: 'Session ID required.' }, 400);

        }



        const session = getSessionData(sessionId);

        if (!session) {

          // An active session may not yet have on-disk metadata: builtin can

          // race in the window between Tab open and first persisted turn.

          // Treat the active session as an empty session-in-progress instead

          // of 404 (which the frontend retries, producing log noise).

          if (sessionId === getSessionId()) {

            return jsonResponse({

              success: true,

              session: {

                id: sessionId,

                runtime: 'builtin',

                messages: [],

                liveStreamingMessage: null,

                liveSessionState: undefined,

                totalCount: 0,

                hasMoreBefore: false,

              },

            });

          }

          return jsonResponse({ success: false, error: 'Session not found.' }, 404);

        }



        // Pagination: `?limit=N` returns only the most recent N messages,

        // keeping the first-paint JSON body tiny even for 600-message sessions.

        // `?before=<messageId>` loads the N messages immediately older than the

        // given id, used by the MessageList startReached handler to lazily

        // fetch history as the user scrolls up.

        //

        // Clamp limit to [1, 500]. 0 / missing means "full load" (preserved for

        // callers that genuinely need all messages, e.g. sessions/fork UI).

        const rawLimit = parseInt(url.searchParams.get('limit') ?? '0', 10);

        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 0;

        const before = url.searchParams.get('before');



        const liveStreamingMessage: {

          id: string;

          role: 'assistant';

          content: string;

          timestamp: string;

          sdkUuid?: string;

        } | null = null;



        // If this is the currently active session, merge in-memory messages.

        // In-memory messages include the current turn's in-progress content

        // (thinking, text, tool_use) that hasn't been persisted to disk yet.

        // This is critical for shared Sidecar: when a Tab opens an IM session

        // mid-turn, it needs to see the partial assistant response.

        let mergedMessages = session.messages;

        if (sessionId === getSessionId()) {

          const inMemory = getPiMessages();

          if (inMemory.length > 0) {

            const diskIds = new Set(session.messages.map(m => m.id));

            const newMessages = inMemory
              // tool 消息只进 /chat/stream 回放;本 API(SessionMessage)契约不变。
              .filter(m => !diskIds.has(m.id) && m.role !== 'tool')
              .map(m => ({

                id: m.id,

                role: m.role as 'user' | 'assistant',

                content: m.content,

                timestamp: m.timestamp,

                attachments: m.attachments?.map(a => ({

                  id: a.id,

                  name: a.name,

                  mimeType: a.mimeType,

                  path: '',

                })),

              }));

            if (newMessages.length > 0) {

              mergedMessages = [...session.messages, ...newMessages];

            }

          }

        }



        // Apply pagination slice. hasMoreBefore tells the client whether there

        // are older messages on disk that it could fetch with ?before=.

        const totalCount = mergedMessages.length;

        let paginatedMessages = mergedMessages;

        let hasMoreBefore = false;

        if (limit > 0) {

          if (before) {

            const beforeIdx = mergedMessages.findIndex(m => m.id === before);

            // beforeIdx < 0 is a stale cursor — the client's baseline is gone,

            // so return an empty page and let the client fall back to full load.

            if (beforeIdx < 0) {

              paginatedMessages = [];

              hasMoreBefore = false;

            } else {

              const start = Math.max(0, beforeIdx - limit);

              paginatedMessages = mergedMessages.slice(start, beforeIdx);

              hasMoreBefore = start > 0;

            }

          } else {

            const start = Math.max(0, totalCount - limit);

            paginatedMessages = mergedMessages.slice(start);

            hasMoreBefore = start > 0;

          }

        }



        // Attachments ship as metadata only. Binary previews are served by the

        // Tauri `zhishi://attachment/<path>` custom protocol (zero-copy, no JSON

        // round-trip), keeping the JSON body small even for sessions with dozens

        // of screenshots. Browser dev mode uses the /api/attachment/* fallback

        // route below.

        const sessionWithPreview = {

          ...redactSessionMetadata(session),

          liveStreamingMessage,

          liveSessionState: undefined,

          messages: shrinkSessionMessagesForClient(paginatedMessages),

          totalCount,

          hasMoreBefore,

        };



        return jsonResponse({ success: true, session: sessionWithPreview });

}

export async function handleDeleteSession(pathname: string, jsonResponse: JsonResponseFn): Promise<Response> {

        const sessionId = pathname.replace('/sessions/', '');

        if (!sessionId) {

          return jsonResponse({ success: false, error: 'Session ID required.' }, 400);

        }



        const deleted = await deleteSession(sessionId);

        if (!deleted) {

          return jsonResponse({ success: false, error: 'Session not found.' }, 404);

        }



        return jsonResponse({ success: true });

}

export async function handlePatchSession(pathname: string, request: Request, jsonResponse: JsonResponseFn): Promise<Response> {

        const sessionId = pathname.replace('/sessions/', '');

        if (!sessionId) {

          return jsonResponse({ success: false, error: 'Session ID required.' }, 400);

        }



        // Snapshot fields (v0.1.69): send `null` to clear (revert to agent fallback);

        // omit a field to leave it unchanged.

        interface PatchPayload {

          title?: string;

          titleSource?: 'default' | 'auto' | 'user';

          /** Pin/unpin to the 收藏 filter view. Storage convention: only

           *  `true` is persisted; `false` is stored as `undefined` so a

           *  freshly toggled-off session matches "never favorited" exactly

           *  on disk. */

          favorite?: boolean;

          /** 1.3.3 历史面板 — 置顶(排序信号,与 favorite 收藏语义独立)。 */

          pinned?: boolean;

          /** 1.3.3 历史面板 — 归档(默认不出主列表,数据不删)。 */

          archived?: boolean;

          model?: string | null;

          permissionMode?: string | null;

          providerId?: string | null;

          providerEnvJson?: string | null;

        }



        let payload: PatchPayload;

        try {

          payload = (await request.json()) as PatchPayload;

        } catch {

          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);

        }



        // `lastActiveAt` is the recency signal that drives history sort

        // order. Bumping it on EVERY PATCH means a pure-UI flag change

        // (favorite toggle) makes an old session jump to the top of the

        // dropdown — confusing UX (Codex round-4 caught). Only the fields

        // that genuinely represent "session was used" should refresh it.

        const RECENCY_BUMP_FIELDS = new Set([

          'title',           // user-edited title implies engagement

          'titleSource',

          'model',

          'permissionMode',

          'providerId',

          'providerEnvJson',

        ]);

        const touchedRecencyField = (Object.keys(payload) as Array<keyof PatchPayload>)

          .filter((k) => payload[k] !== undefined)

          .some((k) => RECENCY_BUMP_FIELDS.has(k));



        const updates: Record<string, unknown> = touchedRecencyField

          ? { lastActiveAt: new Date().toISOString() }

          : {};

        if (payload.title !== undefined) updates.title = String(payload.title).slice(0, 100);

        if (payload.titleSource !== undefined) updates.titleSource = payload.titleSource;

        if (payload.favorite !== undefined) {

          // Convert false → undefined so the on-disk shape stays minimal

          // (the JSON serializer drops undefined keys).

          updates.favorite = payload.favorite === true ? true : undefined;

        }

        if (payload.pinned !== undefined) {

          updates.pinned = payload.pinned === true ? true : undefined;

        }

        if (payload.archived !== undefined) {

          updates.archived = payload.archived === true ? true : undefined;

        }



        // Snapshot fields: null → clear (undefined in stored JSON); value → set.

        // `undefined` in stored metadata is how the resolver recognizes "fall back to agent".

        const snapshotKeys = [

          'model',

          'permissionMode',

          'providerId',

          'providerEnvJson',

        ] as const;

        let wroteSnapshotField = false;

        for (const key of snapshotKeys) {

          const v = payload[key];

          if (v === undefined) continue;

          updates[key] = v === null ? undefined : v;

          wroteSnapshotField = true;

        }



        // Stamp configSnapshotAt on the first snapshot write (lazy migration).

        // Also bumps on subsequent writes — harmless, useful for debugging.

        if (wroteSnapshotField) {

          updates.configSnapshotAt = new Date().toISOString();

        }



        const updated = await updateSessionMetadata(sessionId, updates);



        if (!updated) {

          return jsonResponse({ success: false, error: 'Session not found.' }, 404);

        }



        // Zero-trust: redact credential-bearing fields from the echo payload.

        // The client already owns what it sent; no need to round-trip secrets.

        return jsonResponse({ success: true, session: redactSessionMetadata(updated) });

}

export async function handleSwitchSession(request: Request, jsonResponse: JsonResponseFn): Promise<Response> {

        let payload: { sessionId?: string };

        try {

          payload = (await request.json()) as { sessionId?: string };

        } catch {

          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);

        }



        if (!payload.sessionId) {

          return jsonResponse({ success: false, error: 'sessionId is required.' }, 400);

        }



        const success = await switchPiSession(payload.sessionId);

        if (!success) {

          return jsonResponse({ success: false, error: 'Session not found.' }, 404);

        }



        console.log(`[sessions] Switched to session: ${payload.sessionId}`);

        return jsonResponse({ success: true, sessionId: payload.sessionId });

}

export async function handleGenerateSessionTitle(request: Request, jsonResponse: JsonResponseFn): Promise<Response> {

        let payload: {

          sessionId: string;

          rounds?: Array<{ user: string; assistant: string }>;

          // Legacy fields (single-round fallback)

          userMessage?: string;

          assistantReply?: string;

          model: string;

          providerEnv?: ProviderEnv;

        };

        try {

          payload = (await request.json()) as typeof payload;

        } catch {

          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);

        }



        if (!payload.sessionId) {

          return jsonResponse({ success: false, error: 'sessionId is required.' }, 400);

        }



        // Build rounds from payload — prefer `rounds` array, fall back to legacy fields

        let rounds: Array<{ user: string; assistant: string }>;

        if (payload.rounds && Array.isArray(payload.rounds) && payload.rounds.length > 0) {

          // Cap to 10 rounds max, validate shape, enforce length limits

          rounds = payload.rounds.slice(0, 10)

            .filter((r: unknown): r is Record<string, unknown> => r !== null && typeof r === 'object')

            .map(r => ({

              user: (typeof r.user === 'string' ? r.user : '').slice(0, 500),

              assistant: (typeof r.assistant === 'string' ? r.assistant : '').slice(0, 500),

            }));

          if (rounds.length === 0) {

            return jsonResponse({ success: false, error: 'rounds must contain valid entries.' }, 400);

          }

        } else if (payload.userMessage) {

          // Legacy single-round format

          rounds = [{

            user: payload.userMessage.slice(0, 1000),

            assistant: (payload.assistantReply || '').slice(0, 1000),

          }];

        } else {

          return jsonResponse({ success: false, error: 'rounds or userMessage is required.' }, 400);

        }



        payload.model = (payload.model || '').slice(0, 200);



        // Skip if session not found or user has manually renamed

        const meta = getSessionMetadata(payload.sessionId);

        if (!meta) {

          return jsonResponse({ success: false, error: 'Session not found.' }, 404);

        }

        if (meta.titleSource === 'user') {

          return jsonResponse({ success: false, skipped: true });

        }



        // Manual trigger. Delegates to the backend Title Service core

        // (TOCTOU re-check + persist + broadcast), the SAME path the post-turn

        // auto trigger uses — see session-title-service.ts. Model/providerEnv

        // come from the request; agentDir is passed as workspace context.

        const { generateAndApplyTitle } = await import('../session-title-service');

        const title = await generateAndApplyTitle(

          payload.sessionId,

          rounds,

          payload.model || '',

          payload.providerEnv,

          meta.agentDir,

        );

        return title ? jsonResponse({ success: true, title }) : jsonResponse({ success: false });

}
