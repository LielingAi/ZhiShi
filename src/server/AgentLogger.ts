/**
 * AgentLogger - Handles agent session logging with lazy file creation
 *
 * Features:
 * - Lazy file creation: only creates log file on first write
 * - Centralized log directory: ~/.zhishi/logs/
 * - Session-based naming: {date}-{sessionId}.log
 *
 * Retention: handled by `./log-retention.ts` for the whole `~/.zhishi/logs/`
 * directory (age + byte budget across all sources). Per-session log files
 * had no byte budget pre-#121; they share the unified policy now.
 */

import { createWriteStream, type WriteStream } from 'fs';
import { join } from 'path';

import { LOGS_DIR, ensureLogsDir } from './logUtils';
import { localDate } from '../shared/logTime';

// In-memory log buffer for UI display
const logLines: string[] = [];
const MAX_LOG_LINES = 2000;

// Current log stream state
let logStream: WriteStream | null = null;
let currentSessionId: string | null = null;
let currentLogFilePath: string | null = null;
// Date of the open stream's filename — long-running sessions (IM bot / cron)
// must roll to the new date's file at midnight, otherwise their logs land in
// yesterday's file and "grep today's date" misses them (2026-08-06 audit F-17).
let currentLogDate: string | null = null;

/**
 * Get log file path for a session
 * Format: {YYYY-MM-DD}-{sessionId}.log
 */
function getLogFilePath(sessionId: string): string {
  return join(LOGS_DIR, `${localDate()}-${sessionId}.log`);
}

/**
 * Initialize logger for a new session
 * Does NOT create the file - just prepares the session ID
 */
export function initLogger(sessionId: string): void {
  // Close previous stream if exists
  if (logStream) {
    logStream.end();
    logStream = null;
  }

  currentSessionId = sessionId;
  currentLogFilePath = null; // Reset - will be created on first write
  currentLogDate = null;
  logLines.length = 0; // Clear in-memory buffer
}

/**
 * Append a log line (lazy file creation)
 * Creates the log file on first write
 */
export function appendLog(line: string): void {
  // Add to in-memory buffer
  logLines.push(line);
  if (logLines.length > MAX_LOG_LINES) {
    logLines.shift();
  }

  // Midnight rollover: the filename embeds the date, so a session crossing
  // midnight must reopen under the new date.
  if (logStream && currentLogDate && currentLogDate !== localDate()) {
    logStream.end();
    logStream = null;
    currentLogFilePath = null;
    currentLogDate = null;
  }

  // Lazy file creation
  if (!logStream && currentSessionId) {
    ensureLogsDir();
    currentLogDate = localDate();
    currentLogFilePath = getLogFilePath(currentSessionId);
    logStream = createWriteStream(currentLogFilePath, { flags: 'a' });
  }

  // Write to file
  logStream?.write(`${line}\n`);
}

/**
 * Get current log lines (for UI display)
 */
export function getLogLines(): string[] {
  return logLines;
}

/**
 * Returns the path of the per-session log file we're currently writing to,
 * if any. Used by `log-retention` so the budget sweep never evicts a file
 * we're holding an open `WriteStream` for. Null until the first append.
 */
export function getActiveSessionLogPath(): string | null {
  return currentLogFilePath;
}

