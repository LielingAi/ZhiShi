/**
 * Agent Loader Module
 *
 * Scans, loads, and manages agent definition files.
 *
 * ## Protocol alignment with Claude Agent SDK / Claude Code
 *
 * Claude Code's agent discovery (src/utils/markdownConfigLoader.ts +
 * src/tools/AgentTool/loadAgentsDir.ts) recursively finds *.md under
 * `.claude/agents/` and treats any file with a non-empty `name` +
 * `description` frontmatter as a valid agent. The file/folder name carries
 * no semantic meaning — the agent's identity comes from `frontmatter.name`.
 *
 * Our scanner (pre-v0.1.70) required a strict `<folder>/<folder>.md`
 * layout, which silently dropped any agent a user placed elsewhere — while
 * the SDK still loaded them (it walks `settingSources: ['project']` itself).
 * Result: agents visible to the AI at runtime but invisible to ZhiShi UI.
 *
 * This module now recognises three layouts (see `AgentLayout` in shared):
 *
 *   folder: <base>/<folderName>/<folderName>.md    ← ZhiShi canonical
 *   flat:   <base>/<folderName>.md                  ← Claude Code convention
 *   nested: <base>/<dir>/.../<stem>.md              ← Claude Code plugin layout
 *
 * Writes keep producing the `folder` layout (pit of success: the thing we
 * create stays renameable and has a dedicated home for `_meta.json`).
 *
 * ## folderName = identity
 *
 * `folderName` is the UI's and `_workspace.json`'s stable key. Computing it:
 *   - folder layout:  `folderName = <folder>` (e.g. `novels`)
 *   - flat layout:    `folderName = <stem>` (e.g. `code-reviewer`)
 *   - nested layout:  `folderName = <relative-stem-path>` using POSIX '/'
 *                     (e.g. `team/code-reviewer`)
 *
 * Deduplication: if two layouts resolve to the same folderName, precedence is
 * folder > flat > nested. The first scan wins; subsequent hits are dropped.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, realpathSync } from 'fs';
import type { Dirent } from 'fs';
import { join, relative, sep, basename, extname } from 'path';
import { parseAgentFrontmatter, parseFullAgentContent, toSdkAgentDefinition } from '../../shared/agentCommands';
import type { AgentItem, AgentLayout, AgentMeta, AgentWorkspaceConfig } from '../../shared/agentTypes';
import { isWindowsReservedName } from '../../shared/utils';
import { ensureDirSync, isDirEntry } from '../utils/fs-utils';

/**
 * Safety cap on recursion depth. Claude Code's scanner is unbounded and
 * relies on inode dedup. We combine a depth cap with a realpath visited-set
 * (see walkMarkdown) — depth alone is not enough to defend against symlink
 * cycles, because a 2-node cycle (A→B, B→A) still expands branch^depth
 * readFileSync calls before stopping.
 */
const MAX_SCAN_DEPTH = 8;

/**
 * Files we explicitly skip during scanning. SKILL.md is a skill marker, not
 * an agent; `_meta.json` / `_workspace.json` / `README.md` are ZhiShi
 * metadata or conventional docs.
 */
const SKIP_FILENAMES = new Set(['SKILL.md', 'README.md', '_meta.json', '_workspace.json']);

/**
 * Read _meta.json for a given agent folder
 */
export function readAgentMeta(agentFolderPath: string): AgentMeta | undefined {
    const metaPath = join(agentFolderPath, '_meta.json');
    try {
        if (existsSync(metaPath)) {
            return JSON.parse(readFileSync(metaPath, 'utf-8')) as AgentMeta;
        }
    } catch {
        // _meta.json is optional, silently ignore parse errors
    }
    return undefined;
}

/**
 * Write _meta.json for a given agent folder.
 * Only meaningful for the 'folder' layout — flat/nested layouts have no
 * dedicated directory to host the sidecar file.
 */
export function writeAgentMeta(agentFolderPath: string, meta: AgentMeta): void {
    if (!existsSync(agentFolderPath)) {
        ensureDirSync(agentFolderPath);
    }
    const metaPath = join(agentFolderPath, '_meta.json');
    writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
}

/**
 * Recursively yield `.md` files under `root`.
 *
 * Skips: dot-hidden entries ('.foo'); well-known metadata filenames
 * (SKIP_FILENAMES); anything past MAX_SCAN_DEPTH; Windows reserved names
 * ('CON.md', 'PRN.md', 'AUX.md', 'NUL.md', 'COM1.md', …) — opening those
 * on Windows attaches to a character device and reads forever.
 *
 * Does NOT skip '_' prefixed directories — Claude Code doesn't, and doing so
 * would re-introduce the UI-blind bug (e.g. a user's '_shared/' or plugin's
 * '_plugins/' would load into the SDK but never surface in our list).
 *
 * Follows symlinks (parity with Claude Code's ripgrep --follow). To keep
 * a symlink cycle from exploding into branch^depth readFile calls, we track
 * visited *real* paths via realpathSync; the depth cap is a second backstop
 * for filesystems where realpath is unreliable (e.g. some Windows junctions).
 *
 * Each yielded entry is an absolute file path; callers compute relative
 * identity via `relative(root, absPath)`.
 */
function* walkMarkdown(
    root: string,
    depth = 0,
    visited: Set<string> = new Set(),
): Generator<string> {
    if (depth > MAX_SCAN_DEPTH) return;

    // Canonicalize the directory we're about to descend. If realpath fails
    // (broken link, permission), fall back to the lexical path — better to
    // risk one spurious readFile than to abort the whole scan.
    let canonical: string;
    try { canonical = realpathSync(root); } catch { canonical = root; }
    if (visited.has(canonical)) return;
    visited.add(canonical);

    let entries: Dirent[];
    try {
        entries = readdirSync(root, { withFileTypes: true });
    } catch {
        // Unreadable dir (EPERM on Windows junction target, race during delete,
        // etc.) — skip silently, don't let one bad path kill the whole scan.
        return;
    }
    for (const entry of entries) {
        const name = entry.name;
        if (name.startsWith('.')) continue;
        const full = join(root, name);

        // Follows symlinks + Windows junctions — matches Claude Code's
        // `ripgrep --follow`. Uses the shared fs-utils helper so scanners
        // across the server (skills, commands, agents) handle junctions
        // consistently.
        if (isDirEntry(entry, full)) {
            yield* walkMarkdown(full, depth + 1, visited);
            continue;
        }
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        if (SKIP_FILENAMES.has(name)) continue;
        if (!name.toLowerCase().endsWith('.md')) continue;
        // Windows reserved device names (CON/PRN/AUX/NUL/COM1-9/LPT1-9) open
        // character devices when readFileSync'd — must filter before reading.
        if (isWindowsReservedName(basename(name, extname(name)))) continue;
        yield full;
    }
}

/**
 * Compute (folderName, layout) from an agent's on-disk location.
 *
 * Examples (root = /base/.claude/agents):
 *   /base/.claude/agents/foo.md                → { folderName: 'foo',      layout: 'flat'   }
 *   /base/.claude/agents/foo/foo.md            → { folderName: 'foo',      layout: 'folder' }
 *   /base/.claude/agents/team/reviewer.md      → { folderName: 'team/reviewer', layout: 'nested' }
 *   /base/.claude/agents/a/b/c.md              → { folderName: 'a/b/c',    layout: 'nested' }
 */
function classifyLayout(
    root: string,
    absPath: string,
): { folderName: string; layout: AgentLayout } {
    const rel = relative(root, absPath);
    const posixRel = rel.split(sep).join('/');
    // Strip trailing '.md' / '.MD' only
    const stemPath = posixRel.replace(/\.md$/i, '');
    const parts = stemPath.split('/');

    if (parts.length === 1) {
        // flat: <base>/<stem>.md
        return { folderName: parts[0]!, layout: 'flat' };
    }
    if (parts.length === 2 && parts[0] === parts[1]) {
        // folder: <base>/<name>/<name>.md  (ZhiShi canonical)
        return { folderName: parts[0]!, layout: 'folder' };
    }
    return { folderName: stemPath, layout: 'nested' };
}

/**
 * Layout precedence for dedup: higher wins when multiple layouts resolve
 * to the same folderName. 'folder' is preferred because it's the only layout
 * that supports rename + _meta.json.
 */
const LAYOUT_PRIORITY: Record<AgentLayout, number> = {
    folder: 3,
    flat: 2,
    nested: 1,
};

/**
 * Build an AgentItem from a markdown file path, or return undefined if the
 * file is not a valid agent (read error, missing name/description frontmatter).
 *
 * Shared by scanAgents (full sweep) and findAgent (short-circuit lookup) so
 * the validation and meta-reading rules live in one place.
 */
function buildAgentItem(
    baseDir: string,
    mdPath: string,
    scope: 'user' | 'project',
): AgentItem | undefined {
    let content: string;
    try {
        content = readFileSync(mdPath, 'utf-8');
    } catch (err) {
        console.warn(`[agent-loader] Failed to read ${mdPath}:`, err);
        return undefined;
    }

    const { name, description } = parseAgentFrontmatter(content);
    // Claude Code protocol: both fields required and non-empty.
    // Missing frontmatter = silent skip (the file is probably a doc).
    if (!name || !description) return undefined;

    const { folderName, layout } = classifyLayout(baseDir, mdPath);

    // _meta.json only lives next to 'folder' layout agents. For flat/nested
    // layouts, there's no unambiguous place for a sidecar file (parent dir
    // is shared), so we don't try to read one.
    const meta = layout === 'folder'
        ? readAgentMeta(join(baseDir, folderName))
        : undefined;

    return {
        name: meta?.displayName || name || folderName,
        description,
        scope,
        path: mdPath,
        folderName,
        layout,
        ...(meta ? { meta } : {}),
        ...(meta?.author === 'claude-code-sync' ? { synced: true } : {}),
    };
}

/**
 * Scan a directory for agent definition files.
 *
 * Recognises the three layouts above. An agent is registered iff its
 * frontmatter has non-empty `name` AND `description` — matching Claude Code's
 * `parseAgentFromMarkdown` validation. Files without proper frontmatter are
 * silently skipped (they're co-located docs, not broken agents).
 */
export function scanAgents(dir: string, scope: 'user' | 'project'): AgentItem[] {
    if (!dir || !existsSync(dir)) return [];

    // folderName → best AgentItem seen so far (by LAYOUT_PRIORITY)
    const byFolderName = new Map<string, AgentItem>();

    try {
        for (const mdPath of walkMarkdown(dir)) {
            const candidate = buildAgentItem(dir, mdPath, scope);
            if (!candidate) continue;
            const existing = byFolderName.get(candidate.folderName);
            if (!existing || LAYOUT_PRIORITY[candidate.layout] > LAYOUT_PRIORITY[existing.layout]) {
                byFolderName.set(candidate.folderName, candidate);
            }
        }
    } catch (error) {
        console.warn(`[agent-loader] Error scanning ${scope} agents in ${dir}:`, error);
    }

    return Array.from(byFolderName.values());
}

/**
 * Read workspace agent config (_workspace.json)
 */
export function readWorkspaceConfig(agentDir: string): AgentWorkspaceConfig {
    const configPath = join(agentDir, '.claude', 'agents', '_workspace.json');
    try {
        if (existsSync(configPath)) {
            const content = readFileSync(configPath, 'utf-8');
            return JSON.parse(content) as AgentWorkspaceConfig;
        }
    } catch (error) {
        console.warn('[agent-loader] Failed to read workspace config:', error);
    }
    return { local: {}, global_refs: {} };
}

/**
 * Write workspace agent config (_workspace.json)
 */
export function writeWorkspaceConfig(agentDir: string, config: AgentWorkspaceConfig): void {
    const agentsDir = join(agentDir, '.claude', 'agents');
    if (!existsSync(agentsDir)) {
        ensureDirSync(agentsDir);
    }
    const configPath = join(agentsDir, '_workspace.json');
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Load enabled agents and convert to SDK AgentDefinition format.
 *
 * Resolution order:
 *   1. Read _workspace.json for enable/disable config.
 *   2. Scan local (project) agents.
 *   3. Scan global (user) agents; skip any folderName already supplied by local.
 *   4. Filter disabled, convert to SDK AgentDefinition.
 *
 * SDK agent key comes from `frontmatter.name` (falling back to folderName) —
 * this is what the model references when delegating via the Task tool.
 */
type SdkAgentDef = ReturnType<typeof toSdkAgentDefinition>;
// `folderName` lets the renderer route from the chat sidebar to the right
// detail panel without a second display-name → folderName lookup. The SDK
// ignores unknown fields, so it's safe to ride along.
type EnabledAgentDef = SdkAgentDef & { scope: 'user' | 'project'; folderName: string };

export function loadEnabledAgents(
    projectAgentsDir: string,
    userAgentsDir: string,
): Record<string, EnabledAgentDef> {
    // Read workspace config for enable/disable state
    // Use the project root (parent of .claude/) as the config base
    const projectRoot = projectAgentsDir ? projectAgentsDir.replace(/[/\\]\.claude[/\\]agents\/?$/, '') : '';
    const wsConfig = projectRoot ? readWorkspaceConfig(projectRoot) : { local: {}, global_refs: {} };

    const result: Record<string, EnabledAgentDef> = {};

    // Scan local agents
    if (projectAgentsDir && existsSync(projectAgentsDir)) {
        const localAgents = scanAgents(projectAgentsDir, 'project');
        for (const agent of localAgents) {
            if (wsConfig.local[agent.folderName]?.enabled === false) continue;

            const content = readFileSync(agent.path, 'utf-8');
            const { frontmatter, body } = parseFullAgentContent(content);
            const agentName = frontmatter.name || agent.folderName;
            result[agentName] = { ...toSdkAgentDefinition(frontmatter, body), scope: 'project', folderName: agent.folderName };
        }
    }

    // Scan global agents (only add if not already present from local)
    if (userAgentsDir && existsSync(userAgentsDir)) {
        const globalAgents = scanAgents(userAgentsDir, 'user');
        for (const agent of globalAgents) {
            if (wsConfig.global_refs[agent.folderName]?.enabled === false) continue;

            const agentName = agent.name;
            if (result[agentName]) continue;

            const content = readFileSync(agent.path, 'utf-8');
            const { frontmatter, body } = parseFullAgentContent(content);
            const resolvedName = frontmatter.name || agent.folderName;
            if (result[resolvedName]) continue;
            result[resolvedName] = { ...toSdkAgentDefinition(frontmatter, body), scope: 'user', folderName: agent.folderName };
        }
    }

    return result;
}

/**
 * Find an agent by (folderName, scope) and return the full AgentItem.
 * Used by GET/PUT/DELETE handlers to resolve `folderName` to a real on-disk
 * path without assuming the `<base>/<name>/<name>.md` layout.
 *
 * Short-circuits vs a full scan:
 *   * classifyLayout is pure-path — wrong folderName rejects before readFile
 *   * 'folder' layout wins LAYOUT_PRIORITY outright, so we return on first
 *     folder-match without walking the rest of the tree
 *   * flat/nested candidates are held until the walk ends (in case a higher-
 *     priority folder match appears later) — at worst, one full walk
 */
export function findAgent(
    baseDir: string,
    scope: 'user' | 'project',
    folderName: string,
): AgentItem | undefined {
    if (!baseDir || !existsSync(baseDir)) return undefined;

    let best: AgentItem | undefined;
    try {
        for (const mdPath of walkMarkdown(baseDir)) {
            const classified = classifyLayout(baseDir, mdPath);
            if (classified.folderName !== folderName) continue;

            const candidate = buildAgentItem(baseDir, mdPath, scope);
            if (!candidate) continue;

            if (candidate.layout === 'folder') return candidate;
            if (!best || LAYOUT_PRIORITY[candidate.layout] > LAYOUT_PRIORITY[best.layout]) {
                best = candidate;
            }
        }
    } catch (error) {
        console.warn(`[agent-loader] Error finding ${folderName} in ${baseDir}:`, error);
    }
    return best;
}
