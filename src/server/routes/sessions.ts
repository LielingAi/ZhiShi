// ============= SESSION API =============
// Extracted from index.ts (1.1.7 ③ god-file strangler split — pure move).
// The /sessions* route branches lived inside main()'s request handler; they
// are now standalone handlers. The only index-module-scope values they
// captured were `jsonResponse`, `pathname` and `url` (all passed in as params)
// plus the session-metadata helpers below.
// 1.5.4 死路由清理：POST /sessions、/sessions/:id/since/:lastMessageId、
// /sessions/:id/stats、/api/generate-session-title 已删（全仓零调用；标题
// 已全走 session-title-service 后端钩子）。

import {
  deleteSession,
  getAllSessionMetadata,
  getSessionData,
  getSessionsByAgentDir,
  isDesktopSessionSource,
  updateSessionMetadata,
} from '../SessionStore';

import { findEnvKeyForLoopSession, loadEnvSessionsMap } from '../environment/env-sessions';

import { resolveLastRealUserMessagePreview, shrinkSessionMessagesForClient } from '../utils/session-message-preview';

import { getSessionId } from '../agent-session';

import { forkPiChat, getPiMessages, switchPiSession } from '../loop/chat-engine';

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



        // Attachments ship as metadata only, keeping the JSON body small

        // even for sessions with dozens of screenshots.

        // (1.5.4: 原 zhishi://attachment 自定义协议与 /api/attachment/* 回退

        // 路由均已不存在——附件二进制当前无在线预览通道,客户端只读元数据。)

        const sessionWithPreview = {

          ...redactSessionMetadata(session),

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

