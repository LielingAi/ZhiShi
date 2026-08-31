/**
 * Cross-platform utilities for environment and path handling
 *
 * Windows vs Unix environment variables:
 * - Home directory: USERPROFILE (Win) vs HOME (Unix)
 * - Username: USERNAME (Win) vs USER (Unix)
 * - Temp directory: TEMP/TMP (Win) vs TMPDIR (Unix)
 */

/**
 * Check if running on Windows
 */
export function isWindows(): boolean {
    return process.platform === 'win32';
}

/**
 * Get cross-platform environment variables
 * Returns consistent values regardless of platform
 */
export function getCrossPlatformEnv(): {
    home: string;
    user: string;
    temp: string;
} {
    const isWin = isWindows();

    // Safe fallback for temp directory:
    // - Windows: TEMP > TMP > C:\Windows\Temp (always exists)
    // - Unix: TMPDIR > /tmp (always exists)
    const tempFallback = isWin ? 'C:\\Windows\\Temp' : '/tmp';

    return {
        home: isWin
            ? (process.env.USERPROFILE || '')
            : (process.env.HOME || ''),
        user: process.env.USER || process.env.USERNAME || '',
        temp: isWin
            ? (process.env.TEMP || process.env.TMP || tempFallback)
            : (process.env.TMPDIR || tempFallback),
    };
}

/**
 * Get home directory or null if not available
 * Use this when you want to handle missing home directory gracefully
 */
export function getHomeDirOrNull(): string | null {
    const { home } = getCrossPlatformEnv();
    return home || null;
}

/**
 * Skills that are unavailable on certain platforms due to upstream bugs.
 * Key = skill folder name, value = set of blocked process.platform values.
 * When the upstream issue is resolved, remove the entry to re-enable.
 */
const PLATFORM_BLOCKED_SKILLS: Record<string, Set<string>> = {
  // agent-browser daemon broken on Windows: vercel-labs/agent-browser#398
  'agent-browser': new Set(['win32']),
};

/** Check if a skill is blocked on the current platform. */
export function isSkillBlockedOnPlatform(skillFolder: string): boolean {
  return PLATFORM_BLOCKED_SKILLS[skillFolder]?.has(process.platform) ?? false;
}
