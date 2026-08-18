/**
 * Shared types for Skills & Commands management
 */
import type { SkillFrontmatter, CommandFrontmatter } from './slashCommands';

// Re-export frontmatter types
export type { SkillFrontmatter, CommandFrontmatter };

/**
 * Skill item in list view
 */
export interface SkillItem {
    name: string;
    description: string;
    scope: 'user' | 'project';
    path: string;
    folderName: string;
    author?: string;
    tags?: string[];    // Vendor-defined tags (fallback to author if not provided by backend)
    enabled?: boolean;  // Global skill enable/disable state (always true for project skills)
}

/**
 * Command item in list view
 */
export interface CommandItem {
    name: string;           // Display name (from frontmatter or fallback to fileName)
    fileName: string;       // Actual file name without .md extension
    description: string;
    scope: 'user' | 'project';
    path: string;
    author?: string;
}

/**
 * Full skill detail with frontmatter and body
 */
export interface SkillDetail {
    name: string;
    folderName: string;
    path: string;
    scope: 'user' | 'project';
    frontmatter: Partial<SkillFrontmatter>;
    body: string;
}

/**
 * Full command detail with frontmatter and body
 */
export interface CommandDetail {
    name: string;           // Display name (from frontmatter or fallback to fileName)
    fileName: string;       // Actual file name without .md extension
    path: string;
    scope: 'user' | 'project';
    frontmatter: Partial<CommandFrontmatter>;
    body: string;
}

export interface ApiSuccessResponse {
    success: boolean;
    error?: string;
    path?: string;
    folderName?: string;
    name?: string;
}

/**
 * Capability kinds shown in AgentCapabilitiesPanel.
 * Used to route a "drill into this item" intent from the chat sidebar
 * to the right detail panel in Settings / WorkspaceConfig.
 */
export type CapabilityKind = 'skill' | 'command' | 'agent';

/**
 * Tells a settings panel "open already showing this item's detail".
 *
 * Discriminated by `kind`, so the on-disk identifier is paired with the
 * kind that owns it — TS rejects mismatches at construction:
 *   - skill   → folderName (e.g. "github")
 *   - command → fileName without .md (e.g. "review")
 *   - agent   → folderName (e.g. "code-reviewer")
 *
 * Display names can be overridden via frontmatter and are not stable —
 * disk identifiers are. Compare with `SlashCommand.source` in `slashCommands.ts`,
 * which has overlapping but narrower domain (no 'agent', plus 'builtin') and
 * therefore can't be reused directly.
 */
export type CapabilityInitialSelect =
    | { kind: 'skill'; folderName: string; scope: 'user' | 'project' }
    | { kind: 'command'; fileName: string; scope: 'user' | 'project' }
    | { kind: 'agent'; folderName: string; scope: 'user' | 'project' };

