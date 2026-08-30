import { randomUUID } from 'crypto';
import type { RuntimeType } from '../../shared/types/runtime';
import type { ContextUsage } from '../../shared/types/context-usage';
import { deriveSessionTitle } from '../../shared/sessionTitle';

/**
 * Session statistics for tracking usage
 */
export interface SessionStats {
    messageCount: number;        // Number of user messages (queries)
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens?: number;
    totalCacheCreationTokens?: number;
}

/**
 * Session metadata stored in sessions.json
 */
export interface SessionMetadata {
    id: string;
    agentDir: string;
    title: string;
    createdAt: string;
    lastActiveAt: string;
    /** @deprecated 统一后新 session 的 sdkSessionId === id，保留用于旧 session 兼容 */
    sdkSessionId?: string;
    /** M4b — pi 引擎会话绑定的 loop-sessions id（~/.zhishi/loop-sessions/<id>.jsonl）。
     *  sidecar 重启后引擎据此续接同一 loop 会话；SDK 会话无此字段。 */
    loopSessionId?: string;
    /** 统一后创建的 session 标记。为 true 时 id 即 SDK session ID */
    unifiedSession?: boolean;
    /** Session statistics */
    stats?: SessionStats;
    /** Associated cron task ID (if this session is used by a scheduled task) */
    cronTaskId?: string;
    /** Session origin — undefined or 'desktop' for Desktop, '{platform}_{type}' for IM/channels */
    source?: SessionSource;
    /** User-pinned to the 收藏 filter view in TaskCenterOverlay /
     *  SessionHistoryDropdown. Only `true` is persisted; absent/false has
     *  identical semantics, so the on-disk size cost is zero for the common
     *  case. */
    favorite?: boolean;
    /**
     * 1.3.3 历史面板 — 置顶。区别于 favorite(收藏筛选):pinned 是排序信号,
     * 置顶的会话排在列表顶部。只持久化 `true`(false 存为 undefined,
     * 与 favorite 同口径的零成本语义)。
     */
    pinned?: boolean;
    /**
     * 1.3.3 历史面板 — 归档。归档会话默认不出现主列表(仍可通过过滤查看),
     * 不删除任何数据。只持久化 `true`。
     */
    archived?: boolean;
    /** Preview of the last user message (truncated, for Task Center display) */
    lastMessagePreview?: string;
    /** How the title was set: default (first message truncation), auto (AI-generated), user (manually renamed) */
    titleSource?: 'default' | 'auto' | 'user';
    /** #296 — number of auto-title GENERATION attempts made for this session.
     *  Bounds retries (MAX_TITLE_GEN_ATTEMPTS): a session whose title-gen keeps
     *  failing won't re-fire on every subsequent turn. Absent = 0. Only the
     *  backend Title Service writes this. */
    titleGenAttempts?: number;
    /** Fork source info — consumed on first session startup, then cleared */
    forkFrom?: {
        sourceSessionId: string;  // Source session's SDK session ID (for resume)
        // Fork point: assistant message's sdkUuid (for resumeSessionAt).
        // Optional because the catch-block recovery at agent-session.ts:9737 clears it when
        // the SDK rejects the anchor as stale ("No message found with message.uuid"), so the
        // retry can degrade to "fork at source tail" instead of looping forever. See issue #220.
        messageUuid?: string;
    };
    /** Which runtime created this session. Absent = 'builtin' (backward compatible) */
    runtime?: RuntimeType;
    /**
     * 安全研究员版 P1 S1 — 非 desktop 的交互场景标记（当前仅 'security'，
     * 由 `zhishi agent` CLI 经 POST /sessions 的 payload.scenario 落入）。
     * startStreamingSession 每个 turn 按此恢复 InteractionScenario，不落
     * 全局 currentScenario（避免与 cron 的 set/reset 时序互相覆盖）。
     * Absent = desktop（向后兼容）。
     */
    interactionScenario?: 'security';
    /** Runtime's own session/thread ID (Codex: threadId, CC: session_id from hook).
     *  Different from our session `id` — used for resume across Sidecar restarts. */
    runtimeSessionId?: string;
    /** Runtime-level cumulative usage totals for restore-safe delta calculation. */
    runtimeUsageTotals?: MessageUsage;
    /**
     * PRD 0.2.32 — 上一轮结束时的 context 用量快照（与实时 chat:context-usage 广播同一个
     * 计算结果 = 单一数据源）。每轮末写入；重开会话时随 session metadata 返回，前端 seed 给
     * 指示器 → 环立即显示真实占用、且与会话期间显示的值一致。前端清空只动展示态，不删此持久值。
     */
    lastContextUsage?: ContextUsage;

    // ─── Session config snapshot (v0.1.69 layered-snapshot model) ───
    // Desktop/Cron owned sessions capture these at creation; IM sessions leave all
    // of them undefined on purpose (live-follow AgentConfig + ChannelOverrides).
    // Read path: `sessionMeta.<field> ?? agent.<field>` — see resolveSessionConfig().

    /** Snapshot model name. Undefined → fallback to agent.model (lazy migration). */
    model?: string;
    /** Snapshot permission mode. Undefined → fallback to agent.permissionMode. */
    permissionMode?: string;
    /** Snapshot providerId. Undefined → fallback to agent.providerId. */
    providerId?: string;
    /** Snapshot provider env JSON (credentials). Undefined → fallback to agent.providerEnvJson. */
    providerEnvJson?: string;
    /** ISO8601 snapshot creation timestamp. Presence marks "this session is locked" — used
     *  by scheduleDeferredRestart guards to skip sessions that own their own config. */
    configSnapshotAt?: string;

    /**
     * Delayed Continue — set ONLY when the inactivity watchdog
     * (`agent-session.ts` setInterval at the watchdog block) aborts a turn
     * that produced at least one SDK event. The owning sidecar schedules an
     * automatic consume after the aborted subprocess terminates; the next
     * user-message enqueue into this session (Chat / IM / inbox / heartbeat /
     * cron-resume — any entry that funnels through `enqueueUserMessage`) can
     * also consume the flag as a crash/restart fallback. Consumption clears it
     * and pre-injects a single `<system-reminder>` turn asking the model to
     * resume from existing context.
     *
     * Clear-on-accept — set to `false` (or removed) after the reminder is
     * accepted into the right session's dispatch path, not after the reminder
     * turn completes. That guarantees **at most one** auto-Continue per abort,
     * even if the reminder turn itself watchdog-aborts. Other abort paths
     * (user ESC, config switch, provider switch, deferred restart, error
     * fallbacks) MUST NOT set this flag — the touchpoint is exactly one line
     * inside the watchdog callback.
     */
    pendingContinueAfterAbort?: boolean;
}

/**
 * Full session data including messages
 */
export interface SessionData extends SessionMetadata {
    messages: SessionMessage[];
}

/**
 * Attachment info for messages
 */
export interface MessageAttachment {
    id: string;
    name: string;
    mimeType: string;
    path: string; // Relative path in attachments directory
}

/**
 * Per-model usage breakdown
 */
export interface ModelUsageEntry {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
}

/**
 * Usage information for assistant messages
 */
export interface MessageUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    /** Primary model (for backwards compatibility and simple display) */
    model?: string;
    /** Per-model breakdown (for detailed statistics) */
    modelUsage?: Record<string, ModelUsageEntry>;
}

/** Session source. IM/channel sources ('{platform}_{private|group}') were removed with
 * the IM channels; only 'desktop' sessions are created now. Legacy persisted
 * metadata may still carry the old IM-shaped strings — readers treat anything
 * non-desktop defensively. */
export type SessionSource = 'desktop';

/**
 * Message source metadata
 */
export interface MessageSourceMetadata {
    source: SessionSource;
    sourceId?: string;
    senderName?: string;
    /** PRD 0.2.37 P5 — 触发消息是否来自另一个 bot（agent↔agent 协作） */
    senderIsBot?: boolean;
}

/**
 * Simplified message format for storage
 */
export interface SessionMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
    sdkUuid?: string;  // SDK 分配的 UUID，用于 resumeSessionAt / rewindFiles
    attachments?: MessageAttachment[];
    /** Usage info (only for assistant messages) */
    usage?: MessageUsage;
    /** Tool call count in this response */
    toolCount?: number;
    /** Response duration in milliseconds */
    durationMs?: number;
    /** Message source metadata (IM integration) */
    metadata?: MessageSourceMetadata;
}

/**
/**
 * Generate session title from first user message
 */
export function generateSessionTitle(message: string): string {
    // Route through the shared deriveSessionTitle so this path (the
    // "session created first, message sent later" flow via
    // updateSessionTitleFromMessage) strips the <system-reminder>/<CRON_TASK>/
    // <HEARTBEAT> wrapper before truncating — same as the other storage sites.
    // Previously a blind slice(0,20) stored a wrapper-only scrap for cron/IM
    // turns (cron-title fix). 40-char cap aligns with the sibling sites.
    return deriveSessionTitle(message, 40) || 'New Chat';
}

/**
 * Create a new session metadata object.
 *
 * Callers MUST build the `snapshot` argument from the paved helpers in
 * `src/server/utils/session-snapshot.ts` (`snapshotForOwnedSession`) —
 * never hand-assemble snapshot fields here.
 * The helpers encode the owner-specific layered-snapshot policy (v0.1.69).
 *
 * Left unspecified, `runtime` defaults to 'builtin' (pit of success: no
 * null/undefined ambiguity on the always-present runtime field).
 */
export function createSessionMetadata(
    agentDir: string,
    snapshot: Partial<SessionMetadata> = {},
): SessionMetadata {
    const now = new Date().toISOString();
    return {
        id: randomUUID(),
        agentDir,
        title: 'New Chat',
        createdAt: now,
        lastActiveAt: now,
        unifiedSession: true,
        runtime: 'builtin',
        ...snapshot,
    };
}
