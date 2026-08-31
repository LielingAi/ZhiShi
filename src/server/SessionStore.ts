/**
 * SessionStore - Handles persistence of session data using JSONL format.
 *
 * Storage structure:
 * ~/.zhishi/
 * ├── sessions.json          # Array of SessionMetadata (index)
 * └── sessions/
 *     ├── {session-id}.jsonl  # Messages in JSONL format (append-only)
 *     └── ...
 *
 * JSONL Benefits:
 * - O(1) append for new messages (no full file rewrite)
 * - Crash recovery: partial writes don't corrupt history
 * - Concurrent safety: append is atomic on most filesystems
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, appendFileSync, statSync, renameSync } from 'fs';
import { join } from 'path';

import type { SessionMetadata, SessionData, SessionMessage, SessionStats, SessionSource } from './types/session';
import { createSessionMetadata, generateSessionTitle } from './types/session';
import { stripBom } from '../shared/utils';
import { ensureDirSync } from './utils/fs-utils';
import { withFileLock } from './utils/file-lock';
import { countNonEmptyJsonlLines } from './utils/jsonl-line-count';
import { elapsedMs, emitPerfTrace, nowMs } from './utils/perf-trace';
import { getZhiShiDataDir } from './utils/app-dirs';

const ZHISHI_DIR = getZhiShiDataDir();
const SESSIONS_FILE = join(ZHISHI_DIR, 'sessions.json');
const SESSIONS_DIR = join(ZHISHI_DIR, 'sessions');
const ATTACHMENTS_DIR = join(ZHISHI_DIR, 'attachments');
const SESSIONS_TMP_FILE = join(ZHISHI_DIR, 'sessions.json.tmp');
const SESSIONS_LOCK_FILE = join(ZHISHI_DIR, 'sessions.lock');
const SESSIONS_LOCK_DIR = join(ZHISHI_DIR, 'session-locks');
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 30000;

/**
 * Line count cache for JSONL files
 * Avoids repeated file reads when appending messages
 * Cache is per-process (each Sidecar maintains its own cache)
 */
const lineCountCache = new Map<string, number>();

/**
 * Get cached line count, reading from file only on cache miss
 */
function getCachedLineCount(sessionId: string, filePath: string): number {
    const cached = lineCountCache.get(sessionId);
    if (cached !== undefined) {
        emitPerfTrace({
            trace: 'storage_io',
            phase: 'line_count_cache_hit',
            sessionId,
            count: cached,
            status: 'ok',
        });
        return cached;
    }
    // Cold start: read from file
    const start = nowMs();
    const count = countLinesFromFile(filePath);
    let sizeBytes: number | undefined;
    try {
        sizeBytes = existsSync(filePath) ? statSync(filePath).size : 0;
    } catch {
        sizeBytes = undefined;
    }
    emitPerfTrace({
        trace: 'storage_io',
        phase: 'line_count_cache_miss',
        sessionId,
        durationMs: elapsedMs(start),
        sizeBytes,
        count,
        status: 'ok',
    });
    lineCountCache.set(sessionId, count);
    return count;
}

/**
 * Update cached line count after appending messages
 */
function incrementLineCount(sessionId: string, delta: number): void {
    const current = lineCountCache.get(sessionId) ?? 0;
    lineCountCache.set(sessionId, current + delta);
}

/**
 * Clear line count cache for a session (on delete)
 */
function clearLineCountCache(sessionId: string): void {
    lineCountCache.delete(sessionId);
}

/**
 * File locking for sessions.json + per-session JSONL concurrent access safety.
 *
 * Pattern 5 §5.4 invariant: no synchronous event-loop blocking. We use the
 * shared async {@link withFileLock} helper (atomic mkdir lock, polled with
 * setTimeout — never Atomics.wait, never busy-spin). This forces all writer
 * paths in SessionStore to be async, and callers cascade `await` accordingly.
 *
 * Stale-recovery rules (delegated to withFileLock):
 *   - lockdir owner file format: `node:<pid>` / `rust:<pid>` / `renderer:<ts>`
 *   - lockdir age > LOCK_STALE_MS AND owner pid dead → broken automatically.
 *   - renderer:* owners (no observable pid) → age-only break.
 *
 * Lock hold time is ~1ms per call (single append + sessions.json stats update).
 */
async function withSessionsLock<T>(fn: () => Promise<T>): Promise<T> {
    return withFileLock(
        { lockPath: SESSIONS_LOCK_FILE, timeoutMs: LOCK_TIMEOUT_MS, staleMs: LOCK_STALE_MS },
        fn,
    );
}

/**
 * Per-session JSONL writer lock. Serializes append + rewind on
 * `<session>.jsonl` against any other writer (cross-tab cron, background
 * completion, future multi-owner cases).
 */
async function withSessionFileLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const safeId = sessionId.replace(/[^a-zA-Z0-9-]/g, '_');
    if (!existsSync(SESSIONS_LOCK_DIR)) {
        try { mkdirSync(SESSIONS_LOCK_DIR, { recursive: true }); } catch { /* ignore — withFileLock will surface acquire failures */ }
    }
    const lockPath = join(SESSIONS_LOCK_DIR, `${safeId}.jsonl.lock`);
    return withFileLock(
        { lockPath, timeoutMs: LOCK_TIMEOUT_MS, staleMs: LOCK_STALE_MS },
        fn,
    );
}

/**
 * Atomic write: write to tmp file then rename.
 * Prevents data loss from partial writes (process crash / power loss during writeFileSync).
 * rename() is atomic on POSIX (macOS/Linux) and near-atomic on Windows (NTFS MoveFileEx).
 */
function atomicWriteSessionsFile(content: string): void {
    const start = nowMs();
    writeFileSync(SESSIONS_TMP_FILE, content, 'utf-8');
    renameSync(SESSIONS_TMP_FILE, SESSIONS_FILE);
    emitPerfTrace({
        trace: 'storage_io',
        phase: 'sessions_metadata_write',
        durationMs: elapsedMs(start),
        sizeBytes: Buffer.byteLength(content, 'utf-8'),
        status: 'ok',
    });
}

/**
 * Ensure storage directories exist
 */
function ensureStorageDir(): void {
    if (!existsSync(ZHISHI_DIR)) {
        ensureDirSync(ZHISHI_DIR);
    }
    if (!existsSync(SESSIONS_DIR)) {
        ensureDirSync(SESSIONS_DIR);
    }
    if (!existsSync(ATTACHMENTS_DIR)) {
        ensureDirSync(ATTACHMENTS_DIR);
    }
}

/**
 * Validate session ID to prevent path traversal attacks
 */
function isValidSessionId(sessionId: string): boolean {
    // Allow UUID format and session-timestamp-random format
    return /^[a-zA-Z0-9-]+$/.test(sessionId) && sessionId.length > 0 && sessionId.length < 100;
}

/**
 * Get the JSONL file path for a session
 */
function getSessionFilePath(sessionId: string): string {
    if (!isValidSessionId(sessionId)) {
        throw new Error(`[SessionStore] Invalid session ID: ${sessionId}`);
    }
    return join(SESSIONS_DIR, `${sessionId}.jsonl`);
}

/**
 * Get the legacy JSON file path (for migration)
 */
function getLegacySessionFilePath(sessionId: string): string {
    if (!isValidSessionId(sessionId)) {
        throw new Error(`[SessionStore] Invalid session ID: ${sessionId}`);
    }
    return join(SESSIONS_DIR, `${sessionId}.json`);
}

/**
 * Count lines in a JSONL file by reading the file (internal, use getCachedLineCount for performance)
 */
function countLinesFromFile(filePath: string): number {
    return countNonEmptyJsonlLines(filePath);
}

/**
 * Read messages from JSONL file with per-line error tolerance
 * Corrupted lines are skipped to prevent data loss
 */
function readMessagesFromJsonl(filePath: string): SessionMessage[] {
    if (!existsSync(filePath)) {
        return [];
    }

    try {
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').filter(line => line.trim());
        const messages: SessionMessage[] = [];

        for (let i = 0; i < lines.length; i++) {
            try {
                messages.push(JSON.parse(lines[i]) as SessionMessage);
            } catch (lineError) {
                // Skip corrupted lines but continue processing
                console.warn(`[SessionStore] Skipping corrupted line ${i + 1}:`, lineError);
            }
        }

        return messages;
    } catch (error) {
        console.error('[SessionStore] Failed to read JSONL file:', error);
        return [];
    }
}

/**
 * Migrate legacy JSON file to JSONL format
 * Handles interrupted migrations (both files exist) gracefully
 */
function migrateToJsonl(sessionId: string): SessionMessage[] {
    const legacyPath = getLegacySessionFilePath(sessionId);
    const jsonlPath = getSessionFilePath(sessionId);

    // Handle interrupted migration: if both files exist, prefer JSONL and cleanup legacy
    if (existsSync(jsonlPath) && existsSync(legacyPath)) {
        console.log(`[SessionStore] Cleaning up interrupted migration: ${sessionId}`);
        try {
            unlinkSync(legacyPath);
        } catch (e) {
            console.warn('[SessionStore] Failed to cleanup legacy file:', e);
        }
        return readMessagesFromJsonl(jsonlPath);
    }

    if (!existsSync(legacyPath)) {
        return [];
    }

    try {
        // Read legacy JSON
        const content = readFileSync(legacyPath, 'utf-8');
        const data = JSON.parse(content) as { messages: SessionMessage[] };
        const messages = data.messages ?? [];

        if (messages.length > 0) {
            // Write to JSONL format
            const jsonlContent = messages.map(msg => JSON.stringify(msg)).join('\n') + '\n';
            writeFileSync(jsonlPath, jsonlContent, 'utf-8');
            console.log(`[SessionStore] Migrated ${messages.length} messages to JSONL: ${sessionId}`);
        }

        // Remove legacy file
        unlinkSync(legacyPath);
        console.log(`[SessionStore] Removed legacy JSON file: ${sessionId}`);

        return messages;
    } catch (error) {
        console.error('[SessionStore] Migration failed:', error);
        return [];
    }
}

/**
 * Read all session metadata
 */
export function getAllSessionMetadata(): SessionMetadata[] {
    ensureStorageDir();

    if (!existsSync(SESSIONS_FILE)) {
        return [];
    }

    try {
        const content = readFileSync(SESSIONS_FILE, 'utf-8');
        return JSON.parse(stripBom(content)) as SessionMetadata[];
    } catch (error) {
        console.error('[SessionStore] Failed to read sessions.json:', error);
        return [];
    }
}

/** PRD 0.2.37 — IM 消息不走桌面会话历史，只有 desktop source 才出现在历史列表。 */
export function isDesktopSessionSource(source?: SessionSource): boolean {
    return !source || source === 'desktop';
}

/**
 * Get sessions for a specific agent directory
 */
export function getSessionsByAgentDir(agentDir: string): SessionMetadata[] {
    const all = getAllSessionMetadata();
    return all
        .filter(s => s.agentDir === agentDir && isDesktopSessionSource(s.source))
        .sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime());
}

/**
 * Get session metadata by ID
 */
export function getSessionMetadata(sessionId: string): SessionMetadata | null {
    const all = getAllSessionMetadata();
    return all.find(s => s.id === sessionId) ?? null;
}

/**
 * Save session metadata (create or update)
 */
export async function saveSessionMetadata(session: SessionMetadata): Promise<void> {
    ensureStorageDir();

    await withSessionsLock(async () => {
        const all = getAllSessionMetadata();

        // Safety check: if the file exists on disk but getAllSessionMetadata returned [],
        // a read error (corrupt file, partial write) occurred. Refuse to write to avoid
        // wiping all existing entries. The current session will be retried on next persist.
        if (all.length === 0 && existsSync(SESSIONS_FILE)) {
            try {
                const size = statSync(SESSIONS_FILE).size;
                if (size > 2) { // >2 bytes = not just "[]"
                    console.error(`[SessionStore] Refusing to write: sessions.json has ${size} bytes on disk but read returned []. Possible corruption.`);
                    return;
                }
            } catch { /* stat failed, proceed normally */ }
        }

        const index = all.findIndex(s => s.id === session.id);

        if (index >= 0) {
            all[index] = session;
        } else {
            all.push(session);
        }

        try {
            atomicWriteSessionsFile(JSON.stringify(all, null, 2));
        } catch (error) {
            console.error('[SessionStore] Failed to write sessions.json:', error);
        }
    });
}

/**
 * Delete session metadata and data
 */
export async function deleteSession(sessionId: string): Promise<boolean> {
    ensureStorageDir();

    return withSessionsLock(async () => {
        // Remove from metadata
        const all = getAllSessionMetadata();
        const filtered = all.filter(s => s.id !== sessionId);

        if (filtered.length === all.length) {
            return false; // Not found
        }

        try {
            atomicWriteSessionsFile(JSON.stringify(filtered, null, 2));

            // Remove session data file (both formats)
            const jsonlFile = getSessionFilePath(sessionId);
            const legacyFile = getLegacySessionFilePath(sessionId);

            if (existsSync(jsonlFile)) {
                unlinkSync(jsonlFile);
            }
            if (existsSync(legacyFile)) {
                unlinkSync(legacyFile);
            }

            // Clear line count cache
            clearLineCountCache(sessionId);

            return true;
        } catch (error) {
            console.error('[SessionStore] Failed to delete session:', error);
            return false;
        }
    });
}

/**
 * Get full session data including messages
 */
export function getSessionData(sessionId: string): SessionData | null {
    const metadata = getSessionMetadata(sessionId);
    if (!metadata) {
        return null;
    }

    const jsonlPath = getSessionFilePath(sessionId);
    const legacyPath = getLegacySessionFilePath(sessionId);

    let messages: SessionMessage[] = [];

    // Check for JSONL file first
    if (existsSync(jsonlPath)) {
        messages = readMessagesFromJsonl(jsonlPath);
    }
    // Check for legacy JSON file and migrate
    else if (existsSync(legacyPath)) {
        messages = migrateToJsonl(sessionId);
    }

    return {
        ...metadata,
        messages,
    };
}

/**
 * Calculate session statistics from messages
 */
export function calculateSessionStats(messages: SessionMessage[]): SessionStats {
    let messageCount = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheCreationTokens = 0;

    for (const msg of messages) {
        if (msg.role === 'user') {
            messageCount++;
        } else if (msg.role === 'assistant' && msg.usage) {
            totalInputTokens += msg.usage.inputTokens ?? 0;
            totalOutputTokens += msg.usage.outputTokens ?? 0;
            totalCacheReadTokens += msg.usage.cacheReadTokens ?? 0;
            totalCacheCreationTokens += msg.usage.cacheCreationTokens ?? 0;
        }
    }

    return {
        messageCount,
        totalInputTokens,
        totalOutputTokens,
        totalCacheReadTokens: totalCacheReadTokens || undefined,
        totalCacheCreationTokens: totalCacheCreationTokens || undefined,
    };
}

/**
 * Save session messages using incremental append.
 * Only appends new messages and updates stats incrementally for performance.
 *
 * The stats update is performed inside withSessionsLock to prevent TOCTOU races
 * where another process could modify sessions.json between our read and write.
 */
/**
 * Persist the cumulative message array for a session.
 *
 * `opts.allowShrink` (default true) gates the rewind/retry shrink-rewrite: when
 * `messages.length < existingCount` the file is rewritten to the shorter array
 * (deleting the tail). That is correct for an INTENTIONAL truncation (builtin
 * rewind, external retry) but catastrophic if a caller ever passes a partial /
 * truncated array (e.g. a failed cold-load). Append-only callers MUST pass
 * `allowShrink: false` so a spurious short array refuses to delete on-disk data
 * instead of silently nuking it.
 */
export async function saveSessionMessages(
    sessionId: string,
    messages: SessionMessage[],
    opts?: { allowShrink?: boolean },
): Promise<void> {
    const allowShrink = opts?.allowShrink ?? true;
    ensureStorageDir();

    const filePath = getSessionFilePath(sessionId);
    const legacyPath = getLegacySessionFilePath(sessionId);

    try {
        // Pattern 5: serialize JSONL append/rewrite against any other writer of the
        // same session (cross-tab cron, background completion). Lock hold time is
        // ~1ms per call (single append + sessions.json stats update).
        await withSessionFileLock(sessionId, async () => {
            // Get existing message count (use cached line count for performance)
            let existingCount = 0;

            if (existsSync(filePath)) {
                existingCount = getCachedLineCount(sessionId, filePath);
            } else if (existsSync(legacyPath)) {
                // Migrate first, then get count from new file
                migrateToJsonl(sessionId);
                existingCount = getCachedLineCount(sessionId, filePath);
            }

            // Detect shrink: in-memory messages are fewer than what's on disk.
            // Only an INTENTIONAL truncation (rewind / retry) may rewrite the file
            // to the shorter state. An append-only caller seeing this means its
            // in-memory array is partial (failed/truncated load) — rewriting would
            // delete the on-disk tail, so we refuse and keep the durable copy.
            if (messages.length < existingCount) {
                if (!allowShrink) {
                    console.error(`[SessionStore] REFUSING shrink-rewrite for session ${sessionId}: in-memory ${messages.length} < on-disk ${existingCount} but allowShrink=false (likely a partial/failed load). Keeping the on-disk file intact, skipping write.`);
                    return;
                }
                console.log(`[SessionStore] Intentional truncation: messages.length=${messages.length} < existingCount=${existingCount}, rewriting JSONL for session ${sessionId}`);
                const fullContent = messages.map(msg => JSON.stringify(msg)).join('\n') + (messages.length > 0 ? '\n' : '');
                const rewriteStart = nowMs();
                writeFileSync(filePath, fullContent, 'utf-8');
                emitPerfTrace({
                    trace: 'storage_io',
                    phase: 'session_jsonl_rewrite',
                    sessionId,
                    durationMs: elapsedMs(rewriteStart),
                    sizeBytes: Buffer.byteLength(fullContent, 'utf-8'),
                    count: messages.length,
                    status: 'ok',
                });
                lineCountCache.set(sessionId, messages.length);

                // Recalculate full stats after rewrite
                const fullStats = calculateSessionStats(messages);
                await withSessionsLock(async () => {
                    const session = getSessionMetadata(sessionId);
                    if (!session) return;
                    const all = getAllSessionMetadata();
                    const index = all.findIndex(s => s.id === sessionId);
                    if (index >= 0) {
                        all[index] = { ...session, stats: fullStats };
                        atomicWriteSessionsFile(JSON.stringify(all, null, 2));
                    }
                });
                return;
            }

            // Only append new messages
            const newMessages = messages.slice(existingCount);

            if (newMessages.length > 0) {
                // Append to JSONL file under the per-session lock acquired above.
                const linesToAppend = newMessages.map(msg => JSON.stringify(msg)).join('\n') + '\n';
                const appendStart = nowMs();
                appendFileSync(filePath, linesToAppend, 'utf-8');
                emitPerfTrace({
                    trace: 'storage_io',
                    phase: 'session_jsonl_append',
                    sessionId,
                    durationMs: elapsedMs(appendStart),
                    sizeBytes: Buffer.byteLength(linesToAppend, 'utf-8'),
                    count: newMessages.length,
                    status: 'ok',
                });
                incrementLineCount(sessionId, newMessages.length);
                console.log(`[SessionStore] Appended ${newMessages.length} new messages (total: ${messages.length})`);

                // Update stats in sessions.json atomically (read + calculate + write under lock)
                const incrementalStats = calculateSessionStats(newMessages);
                await withSessionsLock(async () => {
                    // Read metadata inside the lock to prevent TOCTOU race
                    const session = getSessionMetadata(sessionId);
                    if (!session) return;

                    const existingStats = session.stats ?? {
                        messageCount: 0,
                        totalInputTokens: 0,
                        totalOutputTokens: 0,
                    };
                    const updatedStats: SessionStats = {
                        messageCount: existingStats.messageCount + incrementalStats.messageCount,
                        totalInputTokens: existingStats.totalInputTokens + incrementalStats.totalInputTokens,
                        totalOutputTokens: existingStats.totalOutputTokens + incrementalStats.totalOutputTokens,
                        totalCacheReadTokens: ((existingStats.totalCacheReadTokens ?? 0) + (incrementalStats.totalCacheReadTokens ?? 0)) || undefined,
                        totalCacheCreationTokens: ((existingStats.totalCacheCreationTokens ?? 0) + (incrementalStats.totalCacheCreationTokens ?? 0)) || undefined,
                    };

                    // Write directly (we already hold the lock — don't call saveSessionMetadata which would deadlock)
                    const all = getAllSessionMetadata();
                    const index = all.findIndex(s => s.id === sessionId);
                    if (index >= 0) {
                        all[index] = { ...session, stats: updatedStats };
                        atomicWriteSessionsFile(JSON.stringify(all, null, 2));
                    }
                });
            }
        });
    } catch (error) {
        console.error('[SessionStore] Failed to save session messages:', error);
    }
}

/**
 * Update session metadata.
 *
 * Writable keys include config-snapshot fields (v0.1.69) so the PATCH
 * /sessions/:id endpoint can persist model / permissionMode / MCP / provider
 * onto an existing session without replaying the full SessionMetadata blob.
 */
export async function updateSessionMetadata(
    sessionId: string,
    updates: Partial<Pick<SessionMetadata,
        | 'title'
        | 'lastActiveAt'
        | 'sdkSessionId'
        | 'unifiedSession'
        | 'stats'
        | 'source'
        | 'favorite'
        | 'lastMessagePreview'
        | 'titleSource'
        | 'titleGenAttempts'
        | 'runtime'
        | 'runtimeSessionId'
        | 'runtimeUsageTotals'
        | 'lastContextUsage'
        | 'model'
        | 'permissionMode'
        | 'providerId'
        | 'providerEnvJson'
        | 'configSnapshotAt'
        | 'pendingContinueAfterAbort'
    >>,
    /**
     * Optional compare-and-set guard evaluated INSIDE the lock against the
     * freshly-read current metadata. When it returns false the write is skipped
     * and this returns null. This closes a check-then-write TOCTOU that a
     * caller cannot close on its own: reading metadata, deciding, then calling
     * this leaves a window where a concurrent writer can change the very field
     * the decision was based on. Auto-titling uses it to never clobber a title
     * the user renamed during the multi-second LLM call (review #3).
     */
    precondition?: (current: SessionMetadata) => boolean,
): Promise<SessionMetadata | null> {
    // Race-safe read-modify-write — must happen entirely under
    // `withSessionsLock` so a concurrent updater (e.g. periodic stats /
    // title patch / runtime-change freeze) doesn't get its just-applied
    // changes clobbered by us reading a pre-their-write snapshot and
    // writing back the full stale object.
    //
    // Pre-v0.2.14: read happened OUTSIDE the lock, so two concurrent
    // updaters could each compute `{...session, ...patch_X}` from the
    // same snapshot and the second writer would silently drop the first
    // writer's fields. Now: read fresh under the lock, patch, write back
    // — all atomic. (review-by-codex F3.)
    ensureStorageDir();
    let result: SessionMetadata | null = null;
    await withSessionsLock(async () => {
        const all = getAllSessionMetadata();
        const idx = all.findIndex(s => s.id === sessionId);
        if (idx < 0) {
            // session not found — leave result=null
            return;
        }
        if (precondition && !precondition(all[idx])) {
            // CAS guard failed against the in-lock snapshot — skip the write.
            return;
        }
        const updated: SessionMetadata = { ...all[idx], ...updates };
        all[idx] = updated;
        try {
            atomicWriteSessionsFile(JSON.stringify(all, null, 2));
            result = updated;
        } catch (error) {
            console.error('[SessionStore] updateSessionMetadata write failed:', error);
        }
    });
    return result;
}

/**
 * Create a new session for the given agent directory.
 *
 * `snapshot` is the partial SessionMetadata produced by the caller (typically via
 * `snapshotForOwnedSession()`).
 * Hand-assembling fields here is forbidden — go through the helpers in
 * `utils/session-snapshot.ts` so a new field added later cannot silently bypass
 * snapshot capture (PRD §6.2 pit-of-success).
 */
export async function createSession(agentDir: string, snapshot?: Partial<SessionMetadata>): Promise<SessionMetadata> {
    const session = createSessionMetadata(agentDir, snapshot);
    await saveSessionMetadata(session);
    console.log(`[SessionStore] Created session ${session.id} for ${agentDir} runtime=${session.runtime} configSnapshot=${session.configSnapshotAt ? 'yes' : 'no'}`);
    return session;
}

/**
 * Update session title from first message if needed
 */
export async function updateSessionTitleFromMessage(sessionId: string, message: string): Promise<void> {
    const session = getSessionMetadata(sessionId);
    if (!session || session.title !== 'New Chat') {
        return;
    }

    const title = generateSessionTitle(message);
    await updateSessionMetadata(sessionId, { title, titleSource: 'default' });
}

/**
 * Get absolute path to attachment
 */
export function getAttachmentPath(relativePath: string): string {
    return join(ATTACHMENTS_DIR, relativePath);
}
