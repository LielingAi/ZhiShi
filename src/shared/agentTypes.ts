/**

 * Shared types for Sub-Agent management

 * Agents are custom sub-agents that can be invoked via the Task tool

 * Agent definition files use Markdown + YAML Frontmatter format

 */



/**

 * Agent frontmatter interface

 * Matches the Claude Agent SDK AgentDefinition fields

 */

export interface AgentFrontmatter {

    name: string;

    description: string;

    tools?: string;           // Comma-separated tool names

    disallowedTools?: string; // Comma-separated tool names

    model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';

    permissionMode?: string;

    skills?: string[];

    memory?: string;          // Persistent memory: 'user' | 'project' | 'local'

    maxTurns?: number;

    hooks?: Record<string, unknown>; // Lifecycle hooks (PreToolUse, PostToolUse, Stop)

}



/**

 * ZhiShi extension metadata (_meta.json)

 * Stored alongside the .md file, not inside it (preserves Claude Code compatibility)

 */

export interface AgentMeta {

    displayName?: string;     // UI display name (falls back to frontmatter.name)

    icon?: string;            // lucide icon name

    color?: string;           // Theme color hex

    author?: string;

    createdAt?: string;       // ISO 8601

    updatedAt?: string;       // ISO 8601

}



/**

 * On-disk layout form an agent file takes.

 * - 'folder': <base>/<folderName>/<folderName>.md  (ZhiShi canonical, created by /api/agent/create)

 * - 'flat':   <base>/<folderName>.md                (Claude Code convention, single-file agent)

 * - 'nested': <base>/<dir>/.../<stem>.md            (arbitrary depth, folderName = 'dir/.../stem')

 *

 * Only 'folder' supports rename + _meta.json. 'flat' / 'nested' are editable in place

 * but cannot be renamed via UI (the file/dir layout is user-owned).

 */

export type AgentLayout = 'folder' | 'flat' | 'nested';



/**

 * Agent item in list view

 */

export interface AgentItem {

    name: string;

    description: string;

    scope: 'user' | 'project';

    path: string;

    folderName: string;

    layout: AgentLayout;

    meta?: AgentMeta;

    synced?: boolean;         // true if synced from Claude Code

}



/**

 * Workspace-level agent config

 * Controls which agents are enabled for a specific project

 */

export interface AgentWorkspaceConfig {

    local: Record<string, { enabled: boolean }>;

    global_refs: Record<string, { enabled: boolean }>;

}



