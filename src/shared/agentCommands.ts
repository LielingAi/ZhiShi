/**
 * Agent file parsing and serialization
 * Agent definition files use Markdown + YAML Frontmatter format
 * File naming: <name>/<name>.md (compatible with Claude Code agents)
 */

import { load as yamlLoad, dump as yamlDump } from 'js-yaml';
import type { AgentFrontmatter } from './agentTypes';

/**
 * Extract YAML frontmatter string from markdown content
 * Copied from slashCommands.ts (not exported there)
 */
function extractFrontmatter(content: string): { frontmatterStr: string; body: string } | null {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match) {
        return null;
    }
    return {
        frontmatterStr: match[1],
        body: match[2] || ''
    };
}

/**
 * Parse agent frontmatter for list view (name + description only)
 */
export function parseAgentFrontmatter(content: string): { name?: string; description?: string } {
    try {
        const extracted = extractFrontmatter(content);
        if (!extracted) {
            return {};
        }
        const parsed = yamlLoad(extracted.frontmatterStr) as Record<string, unknown> | null;
        if (!parsed || typeof parsed !== 'object') {
            return {};
        }
        return {
            name: typeof parsed.name === 'string' ? parsed.name : undefined,
            description: typeof parsed.description === 'string' ? parsed.description : undefined,
        };
    } catch (e) {
        console.warn('Failed to parse agent frontmatter:', e);
        return {};
    }
}

/**
 * Parse complete agent file content (frontmatter + body)
 */
export function parseFullAgentContent(content: string): {
    frontmatter: Partial<AgentFrontmatter>;
    body: string;
} {
    try {
        const extracted = extractFrontmatter(content);
        if (!extracted) {
            return { frontmatter: {}, body: content };
        }

        const parsed = yamlLoad(extracted.frontmatterStr) as Record<string, unknown> | null;
        if (!parsed || typeof parsed !== 'object') {
            return { frontmatter: {}, body: extracted.body };
        }

        const frontmatter: Partial<AgentFrontmatter> = {};

        if (typeof parsed.name === 'string') frontmatter.name = parsed.name;
        if (typeof parsed.description === 'string') frontmatter.description = parsed.description;
        if (typeof parsed.tools === 'string') frontmatter.tools = parsed.tools;
        if (typeof parsed.disallowedTools === 'string') frontmatter.disallowedTools = parsed.disallowedTools;
        if (typeof parsed.model === 'string') {
            frontmatter.model = parsed.model as AgentFrontmatter['model'];
        }
        if (typeof parsed.permissionMode === 'string') frontmatter.permissionMode = parsed.permissionMode;
        if (Array.isArray(parsed.skills)) {
            frontmatter.skills = parsed.skills.filter((s): s is string => typeof s === 'string');
        }
        if (typeof parsed.memory === 'string') frontmatter.memory = parsed.memory;
        if (typeof parsed.maxTurns === 'number') frontmatter.maxTurns = parsed.maxTurns;
        if (parsed.hooks && typeof parsed.hooks === 'object') {
            frontmatter.hooks = parsed.hooks as Record<string, unknown>;
        }

        return { frontmatter, body: extracted.body };
    } catch (e) {
        console.warn('Failed to parse full agent content:', e);
        return { frontmatter: {}, body: content };
    }
}

/**
 * Serialize agent frontmatter and body back to markdown format
 * Uses js-yaml dump() for safe YAML serialization (handles complex nested structures)
 */
export function serializeAgentContent(frontmatter: Partial<AgentFrontmatter>, body: string): string {
    // Build a clean object for YAML serialization (omit undefined/empty values)
    const yamlObj: Record<string, unknown> = {};

    if (frontmatter.name) yamlObj.name = frontmatter.name;
    if (frontmatter.description) yamlObj.description = frontmatter.description;
    if (frontmatter.tools) yamlObj.tools = frontmatter.tools;
    if (frontmatter.disallowedTools) yamlObj.disallowedTools = frontmatter.disallowedTools;
    if (frontmatter.model) yamlObj.model = frontmatter.model;
    if (frontmatter.permissionMode) yamlObj.permissionMode = frontmatter.permissionMode;
    if (frontmatter.skills && frontmatter.skills.length > 0) yamlObj.skills = frontmatter.skills;
    if (frontmatter.memory) yamlObj.memory = frontmatter.memory;
    if (frontmatter.maxTurns !== undefined) yamlObj.maxTurns = frontmatter.maxTurns;
    if (frontmatter.hooks && Object.keys(frontmatter.hooks).length > 0) yamlObj.hooks = frontmatter.hooks;

    const yamlStr = yamlDump(yamlObj, {
        lineWidth: -1,      // No line wrapping
        quotingType: '"',    // Use double quotes
        forceQuotes: false,  // Only quote when necessary
    }).trim();

    const lines: string[] = ['---', yamlStr, '---', '', body.trim()];
    return lines.join('\n');
}

/**
 * Convert agent frontmatter + body to SDK AgentDefinition format
 * This is the bridge between our file format and the SDK's expected type
 */
export function toSdkAgentDefinition(frontmatter: Partial<AgentFrontmatter>, body: string): {
    description: string;
    prompt: string;
    tools?: string[];
    disallowedTools?: string[];
    model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
    skills?: string[];
    maxTurns?: number;
} {
    const def: ReturnType<typeof toSdkAgentDefinition> = {
        description: frontmatter.description || '',
        prompt: body.trim(),
    };

    // Convert comma-separated tools string to string[]
    if (frontmatter.tools) {
        def.tools = frontmatter.tools.split(',').map(t => t.trim()).filter(Boolean);
    }
    if (frontmatter.disallowedTools) {
        def.disallowedTools = frontmatter.disallowedTools.split(',').map(t => t.trim()).filter(Boolean);
    }
    if (frontmatter.model && frontmatter.model !== 'inherit') {
        def.model = frontmatter.model;
    }
    if (frontmatter.skills && frontmatter.skills.length > 0) {
        def.skills = frontmatter.skills;
    }
    if (frontmatter.maxTurns !== undefined) {
        def.maxTurns = frontmatter.maxTurns;
    }

    return def;
}
