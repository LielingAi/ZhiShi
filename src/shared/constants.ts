/**
 * Session ID management for Session-Centric Sidecar architecture
 * New sessions start with a "pending-{tabId}" ID until the backend creates the real session
 */

/**
 * GUI 产品版本（设置页「关于」展示，替代组件内硬编码——1.3.10）。
 * 1.4.0 起与 package.json / src-tauri 发版版本号同线（GUI 正式发版）。
 */
export const GUI_VERSION = '1.4.1';

export const PENDING_SESSION_PREFIX = 'pending-';

/** Check if a sessionId is a pending (placeholder) session */
export function isPendingSessionId(sessionId: string | null | undefined): boolean {
    return sessionId?.startsWith(PENDING_SESSION_PREFIX) ?? false;
}

/** Create a pending session ID for a new tab */
export function createPendingSessionId(tabId: string): string {
    return `${PENDING_SESSION_PREFIX}${tabId}`;
}

/**
 * Custom event names for cross-component communication
 */
export const CUSTOM_EVENTS = {
    /** Fired when a user-level skill is copied to project directory */
    SKILL_COPIED_TO_PROJECT: 'skill-copied-to-project',
    /** Fired to open Settings page with optional section (e.g., 'mcp', 'providers') */
    OPEN_SETTINGS: 'open-settings',
    /** Fired to open the Task Center singleton tab. Optional payload:
     *  `{ autofocusSearch?: boolean }` — when true, the Task list panel
     *  opens its search input and focuses it (used by Launcher 「我的
     *  任务」 tab's search icon to continue the search intent across
     *  tabs instead of forcing the user to re-click). */
    OPEN_TASK_CENTER: 'open-task-center',
    /** Fired to open the standalone Scheduled Tasks page tab. */
    OPEN_SCHEDULED_TASKS_PAGE: 'open-scheduled-tasks-page',
    /** Fired when user tries to open a Session that's already active in another Tab */
    JUMP_TO_TAB: 'jump-to-tab',
    /** Fired when a session title changes (auto-generated or user rename) — triggers refetch in history/task center */
    SESSION_TITLE_CHANGED: 'session-title-changed',
    /**
     * Fired to open a historical session in a new Chat tab.
     * Payload: `{ sessionId: string; workspacePath: string }`.
     * Used by Task Center's 任务详情 → 执行 session list so clicking a
     * past execution opens it just like clicking an entry in the
     * Launcher's 历史对话 list.
     */
    OPEN_SESSION_IN_NEW_TAB: 'open-session-in-new-tab',
    /**
     * Fired from the global link context menu (LinkContextMenuProvider) when the
     * user picks "预览（内置浏览器）" on an external link. Payload:
     * `{ url: string }`. The currently active Chat tab listens; if its split
     * BrowserPanel is available, it calls `preventDefault()` to claim the
     * action. The dispatcher checks `defaultPrevented` and falls back to
     * `openExternal()` (system browser) when no Chat tab handled it.
     */
    OPEN_IN_BROWSER_PANEL: 'open-in-browser-panel',
    // CONFIG_CHANGED removed — ConfigProvider shares state via Context, no DOM event bridge needed
    // Note: CRON_TASK_STOPPED event removed
    // With Session-centric Sidecar (Owner model), stopping a cron task only releases
    // the CronTask owner. If Tab still owns the Sidecar, it continues running.
} as const;
