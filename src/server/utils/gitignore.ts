import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

/**
 * Ensure a pattern exists in the workspace .gitignore (idempotent, non-fatal).
 * Used by tools that create files under zhishi_files/ to prevent accidental commits.
 */
export function ensureGitignorePattern(workspacePath: string, pattern: string): void {
  try {
    const gitignorePath = join(workspacePath, '.gitignore');
    if (!existsSync(gitignorePath)) {
      writeFileSync(gitignorePath, `${pattern}\n`);
      return;
    }
    const content = readFileSync(gitignorePath, 'utf-8');
    if (!content.split('\n').some(line => line.trim() === pattern)) {
      writeFileSync(gitignorePath, content.endsWith('\n') ? `${content}${pattern}\n` : `${content}\n${pattern}\n`);
    }
  } catch { /* non-fatal — .gitignore is a convenience, not a correctness requirement */ }
}
