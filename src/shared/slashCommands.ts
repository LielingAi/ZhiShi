// 自定义斜杠命令（.claude/commands/）frontmatter 解析/序列化工具
// 供 server 命令文件管理路由使用（skills 支持已随 skills 层删除）

import { load as yamlLoad } from 'js-yaml';

/**
 * Complete Command frontmatter interface
 */
export interface CommandFrontmatter {
    name?: string;
    description: string;
    author?: string;
}

/**
 * Extract YAML frontmatter string from markdown content
 */
export function extractFrontmatter(content: string): { frontmatterStr: string; body: string } | null {
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
 * Extract author from parsed YAML object
 * Checks both top-level (author, Author) and nested (metadata.author, metadata.Author)
 */
function extractAuthor(parsed: Record<string, unknown>): string | undefined {
    // Check top-level author/Author
    if (typeof parsed.author === 'string') return parsed.author;
    if (typeof parsed.Author === 'string') return parsed.Author;

    // Check nested metadata.author/Author
    const metadata = parsed.metadata as Record<string, unknown> | undefined;
    if (metadata && typeof metadata === 'object') {
        if (typeof metadata.author === 'string') return metadata.author;
        if (typeof metadata.Author === 'string') return metadata.Author;
    }

    return undefined;
}
/**
 * Extract command name from file path
 * e.g., "/path/to/review-code.md" -> "review-code"
 * Supports both / and \ path separators for cross-platform compatibility
 */
export function extractCommandName(filePath: string): string {
    const fileName = filePath.split(/[\\/]/).pop() || '';
    return fileName.replace(/\.md$/, '');
}

/**
 * Parse complete Command file content
 * Returns both frontmatter and markdown body content
 * If name is not in frontmatter, tries to extract from first # heading in body
 */
export function parseFullCommandContent(content: string): {
    frontmatter: Partial<CommandFrontmatter>;
    body: string;
} {
    try {
        const extracted = extractFrontmatter(content);
        if (!extracted) {
            // No frontmatter, try to extract name from # heading
            const headingMatch = content.match(/^#\s+(.+)$/m);
            const name = headingMatch ? headingMatch[1].trim() : undefined;
            return { frontmatter: name ? { name } : {}, body: content };
        }

        const parsed = yamlLoad(extracted.frontmatterStr) as Record<string, unknown> | null;
        if (!parsed || typeof parsed !== 'object') {
            return { frontmatter: {}, body: extracted.body };
        }

        const frontmatter: Partial<CommandFrontmatter> = {};
        if (typeof parsed.name === 'string') {
            frontmatter.name = parsed.name;
        }
        if (typeof parsed.description === 'string') {
            frontmatter.description = parsed.description;
        }
        // Extract author from top-level or nested metadata
        const author = extractAuthor(parsed);
        if (author) {
            frontmatter.author = author;
        }

        // If name is not in frontmatter, try to extract from first # heading in body
        if (!frontmatter.name) {
            const headingMatch = extracted.body.match(/^#\s+(.+)$/m);
            if (headingMatch) {
                frontmatter.name = headingMatch[1].trim();
            }
        }

        return { frontmatter, body: extracted.body };
    } catch (e) {
        console.warn('Failed to parse full command content:', e);
        return { frontmatter: {}, body: content };
    }
}

/**
 * Serialize Command frontmatter and body back to markdown format
 */
export function serializeCommandContent(frontmatter: Partial<CommandFrontmatter>, body: string): string {
    const lines: string[] = ['---'];

    // Always quote name to handle special characters (colons, quotes, etc.)
    if (frontmatter.name) {
        lines.push(`name: "${frontmatter.name.replace(/"/g, '\\"')}"`);
    }
    if (frontmatter.description) {
        lines.push(`description: "${frontmatter.description.replace(/"/g, '\\"')}"`);
    }

    lines.push('---');
    lines.push('');
    lines.push(body.trim());

    return lines.join('\n');
}
