// Claude Plugin types (PRD 0.2.17)

//

// A "plugin" here is the unit defined by Anthropic's Claude Code plugin

// protocol: a self-contained directory containing `.claude-plugin/plugin.json`

// plus any combination of `skills/`, `agents/`, `hooks/`, `.mcp.json`,

// `.lsp.json`, `monitors/`, `bin/`, etc. ZhiShi downloads the directory

// to `~/.zhishi/plugins/<name>/` and hands the absolute path to the

// Claude Agent SDK via `Options.plugins: [{ type: 'local', path }]`. The

// SDK is responsible for discovering and wiring the inner components — we

// only manage the directory lifecycle and on/off state.



/**

 * Plugin source type. Currently only "local" is meaningful — every

 * installed plugin sits on disk as a local directory regardless of where

 * it was originally fetched from. The `sourceUrl` field captures the

 * upstream so we can support `reinstall` / future `update`.

 */

export type PluginSourceType = 'local';



/**

 * A single installed plugin entry persisted in `AppConfig.plugins[]`.

 * Truth lives on disk; this record is the index.

 */

export interface PluginEntry {

  /** Stable identifier, "<name>@<source>" (v0.2.17: source is always "local") */

  id: string;

  /** plugin.json::name (kebab-case) — also the directory basename under ~/.zhishi/plugins/ */

  name: string;

  /** v0.2.17 always "local" */

  source: PluginSourceType;

  /**

   * Upstream descriptor for reinstall:

   *   - `github://owner/repo[@ref]`

   *   - `https://...zip`

   *   - `file:///absolute/path`

   */

  sourceUrl: string;

  /** Absolute path on disk (`~/.zhishi/plugins/<name>/`) */

  installPath: string;

  /** plugin.json::version (may be absent for git-tracked plugins without an explicit version) */

  version?: string;

  /** plugin.json::description */

  description?: string;

  /** plugin.json::author?.name */

  author?: string;

  /** plugin.json::publisher (used as fallback tag when no explicit tags) */

  publisher?: string;

  /** plugin.json::homepage */

  homepage?: string;

  /** plugin.json::repository */

  repository?: string;

  /** plugin.json::license */

  license?: string;

  /** ISO 8601 timestamp at install */

  installedAt: string;

}



/**

 * Parsed `.claude-plugin/plugin.json` metadata. Only the subset ZhiShi

 * cares about for UI / record-keeping — component path fields are left

 * for the SDK to interpret.

 */

export interface PluginManifest {

  name: string;

  version?: string;

  description?: string;

  author?: { name?: string; email?: string; url?: string };

  homepage?: string;

  repository?: string;

  license?: string;

  keywords?: string[];

}



/**

 * Lightweight directory scan result — used only for surfacing component

 * counts in the Plugins panel. Authoritative loading happens in the SDK.

 */

export interface PluginComponentInventory {

  skills: string[];        // basename of each skills/<name>/ folder containing SKILL.md

  commands: string[];      // basename of each commands/*.md (legacy form)

  agents: string[];        // basename of each agents/*.md

  hooks: number;           // count of distinct event handlers across hooks/hooks.json

  mcpServers: string[];    // server names declared in .mcp.json

  lspServers: string[];    // language ids declared in .lsp.json

  monitors: string[];      // monitor names declared in monitors/monitors.json

  hasBin: boolean;         // has bin/ with any executables

}



/**

 * Aggregated view returned by `/api/plugin/list`. Combines persisted

 * AppConfig data with live disk status so the UI can flag missing /

 * invalid directories.

 */

/**
 * Activation record attached to encrypted (.zsp) plugins only — comes from
 * the server-side `plugin_licenses` table. Plain plugins keep plugin.json's
 * SPDX license string in `PluginListItem.license`.
 */
export interface PluginLicenseInfo {
  publisher: string;
  activatedAt: number;
}

export interface PluginListItem extends Omit<PluginEntry, 'license'> {

  /** SPDX string for plain plugins; PluginLicenseInfo for encrypted (.zsp) ones. */
  license?: string | PluginLicenseInfo;

  enabled: boolean;

  status: 'ok' | 'missing' | 'invalid';

  warning?: string;

  components?: PluginComponentInventory;

  /** PRD 0.2.17 — lightweight per-entry MCP server name list (cheaper than

   *  full `components`). Surfaced in the chat-input plugin submenu so users

   *  see "plugin X 包含 N 个 MCP server" without a deep scan. */

  mcpServerNames?: string[];

  /** Vendor-defined tags for filtering in the capabilities panel. */

  tags?: string[];

  /** plugin.json::publisher — used as fallback tag when no explicit tags. */
  publisher?: string;

}



/**

 * SSE event published while a plugin install is in flight.

 * Registered in `src/server/sse.ts::SSE_EVENT_PRIORITIES`.

 */

export interface PluginInstallProgressEvent {

  type: 'plugin_install_progress';

  installId: string;

  phase: 'fetching' | 'extracting' | 'validating' | 'writing' | 'done' | 'failed';

  message?: string;

  error?: string;

}



/** Build the persisted id from manifest name + source type. */

export function makePluginId(name: string, source: PluginSourceType = 'local'): string {

  return `${name}@${source}`;

}



/**

 * Sanitize a plugin id for use as a filesystem path segment (data dir).

 * Mirrors Claude Code's `~/.claude/plugins/data/{id}/` convention where

 * any character outside [a-zA-Z0-9_-] is replaced with `-`.

 */

export function sanitizePluginIdForPath(id: string): string {

  return id.replace(/[^a-zA-Z0-9_-]/g, '-');

}

