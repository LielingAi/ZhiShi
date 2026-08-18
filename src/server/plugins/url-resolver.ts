/**
 * url-resolver.ts — Parse user input into a plugin source descriptor.
 *
 * Plugin sources supported in v0.2.17:
 *   - GitHub:   `owner/repo`, `https://github.com/owner/repo[/tree/<ref>[/sub/path]]`
 *   - Raw zip:  `https://.../something.zip`  (any HTTPS host that passes SSRF guard)
 *   - Local:    `file:///absolute/path`  (or a bare absolute path)
 *
 * Distinct from the skills resolver because plugins have different semantics:
 *   - We accept a `subPath` hint pointing at a directory **containing**
 *     `.claude-plugin/plugin.json` (rather than a SKILL.md leaf).
 *   - We accept `file://` for installing from a local directory the user is
 *     iterating on (`claude --plugin-dir ./foo` equivalent).
 *   - We don't accept the `@skillName` shorthand — plugins are identified by
 *     directory layout, not by a frontmatter `name` lookup.
 *
 * The output shape is split into two kinds:
 *   - `kind: 'remote'`  — needs a tarball fetch (GitHub or raw zip)
 *   - `kind: 'local'`   — already on disk, just read the directory
 */

import { resolve as resolvePath, isAbsolute } from 'path';
import { fileURLToPath } from 'node:url';
import type { ResolvedSkillSource } from './tarball-fetcher';

export type ResolvedPluginSource =
  | {
      kind: 'remote';
      /** Display name for UI / errors */
      displayName: string;
      /** Reusable skills-fetcher source — fetcher.ts hands this to fetchSkillZip */
      tarball: ResolvedSkillSource;
      /** Optional subdirectory inside the tree that contains .claude-plugin/plugin.json */
      subPath?: string;
      /** Original user input (kept for AppConfig.plugins.sourceUrl) */
      sourceUrl: string;
    }
  | {
      kind: 'local';
      displayName: string;
      /** Absolute filesystem path to the plugin directory */
      absolutePath: string;
      /** Original user input (e.g. `file:///...`) for AppConfig.plugins.sourceUrl */
      sourceUrl: string;
    };

export class PluginUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginUrlError';
  }
}

/**
 * Normalize user input into a ResolvedPluginSource.
 * Throws PluginUrlError on unrecognized / unsupported input.
 */
export function resolvePluginUrl(rawInput: string): ResolvedPluginSource {
  if (typeof rawInput !== 'string') {
    throw new PluginUrlError('输入必须是字符串');
  }
  const trimmed = rawInput.trim().replace(/^[`'"]+|[`'"]+$/g, '').trim();
  if (!trimmed) {
    throw new PluginUrlError('未识别到有效的来源地址');
  }

  // ---------------------------------------------------------------- file:// or absolute path
  if (trimmed.startsWith('file://')) {
    let p: string;
    try {
      p = fileURLToPath(new URL(trimmed));
    } catch {
      throw new PluginUrlError(`无法解析 file:// URL：${trimmed}`);
    }
    if (!isAbsolute(p)) {
      throw new PluginUrlError(`file:// 必须是绝对路径：${trimmed}`);
    }
    // Defense in depth: reject path traversal segments before any disk touch.
    if (p.split('/').some(seg => seg === '..')) {
      throw new PluginUrlError(`路径含非法 .. 段：${trimmed}`);
    }
    return {
      kind: 'local',
      displayName: p,
      absolutePath: resolvePath(p),
      sourceUrl: trimmed,
    };
  }
  // POSIX-style absolute path (/Users/..., /home/...). `isAbsolute` on
  // POSIX runtimes accepts /; on Windows it accepts both / and \.
  if (isAbsolute(trimmed) && !trimmed.startsWith('http')) {
    if (trimmed.split('/').some(seg => seg === '..')) {
      throw new PluginUrlError(`路径含非法 .. 段：${trimmed}`);
    }
    return {
      kind: 'local',
      displayName: trimmed,
      absolutePath: resolvePath(trimmed),
      sourceUrl: `file://${trimmed}`,
    };
  }
  // Windows-style absolute path (C:\foo, D:/bar). `isAbsolute` running on
  // macOS/Linux dev returns false for these even though Windows users
  // would type them — explicit drive-letter detection lets the same
  // sidecar build accept both forms.
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
    // Reject `..` segments in either separator before any disk touch.
    if (/(^|[\\/])\.\.([\\/]|$)/.test(trimmed)) {
      throw new PluginUrlError(`路径含非法 .. 段：${trimmed}`);
    }
    return {
      kind: 'local',
      displayName: trimmed,
      absolutePath: resolvePath(trimmed),
      sourceUrl: `file:///${trimmed.replace(/\\/g, '/')}`,
    };
  }

  // ---------------------------------------------------------------- Raw zip passthrough
  // .tar.gz / .tgz are intentionally NOT accepted: the underlying
  // ./tarball-fetcher only knows AdmZip (`new AdmZip(buffer)`),
  // so any tar.gz download would 完成→fail late with `无法解压 zip`
  // after spending the bandwidth. Reject upfront with friendly error
  // instead. (Future: add a tar extractor if real demand emerges.)
  if (/^https?:\/\//i.test(trimmed) && /\.zip(\?.*)?$/i.test(trimmed)) {
    if (!/^https:/i.test(trimmed)) {
      throw new PluginUrlError('只接受 HTTPS 链接（SSRF 防护）');
    }
    return {
      kind: 'remote',
      displayName: trimmed,
      tarball: {
        kind: 'raw-zip',
        displayName: trimmed,
        rawZipUrl: trimmed,
      },
      sourceUrl: trimmed,
    };
  }
  if (/^https?:\/\//i.test(trimmed) && /\.(tar\.gz|tgz)(\?.*)?$/i.test(trimmed)) {
    throw new PluginUrlError('暂不支持 .tar.gz / .tgz，请提供 GitHub 仓库或 .zip 链接');
  }

  // ---------------------------------------------------------------- Full GitHub URL
  // Accept all four common copy-paste forms, normalizing missing scheme
  // and bare `github.com/...` / `www.github.com/...` to the canonical
  // https form before matching:
  //   https://github.com/owner/repo
  //   https://www.github.com/owner/repo
  //          github.com/owner/repo        ← bare host (very common copy)
  //          www.github.com/owner/repo    ← rare but trivially handled
  const githubBareMatch = trimmed.match(/^(?:www\.)?github\.com\/(.+)$/i);
  const githubishUrl = githubBareMatch
    ? `https://github.com/${githubBareMatch[1]}`
    : trimmed;
  const fullMatch = githubishUrl.match(
    /^https?:\/\/(?:www\.)?github\.com\/([^/\s#?]+)\/([^/\s#?]+?)(?:\.git)?(?:\/tree\/([^/\s#?]+)((?:\/[^\s#?]+)?))?\/?(?:[?#].*)?$/i,
  );
  if (fullMatch) {
    const [, owner, repo, ref, subPathRaw] = fullMatch;
    assertSafeSegment(owner, 'owner');
    assertSafeSegment(repo.replace(/\.git$/i, ''), 'repo');
    const subPath = normalizeSubPath(subPathRaw);
    const cleanRepo = repo.replace(/\.git$/i, '');
    return {
      kind: 'remote',
      displayName: `${owner}/${cleanRepo}${ref ? `@${ref}` : ''}${subPath ? `/${subPath}` : ''}`,
      tarball: {
        kind: 'github',
        displayName: `${owner}/${cleanRepo}${ref ? `@${ref}` : ''}`,
        owner,
        repo: cleanRepo,
        ref: ref || undefined,
        subPath,
      },
      subPath,
      sourceUrl: trimmed,
    };
  }

  // ---------------------------------------------------------------- github:// shorthand
  if (/^github:\/\//i.test(trimmed)) {
    const stripped = trimmed.slice('github://'.length);
    const m = stripped.match(/^([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*?)(?:@([\w.\-/]+))?(?:\/(.+))?$/);
    if (m) {
      const [, owner, repo, ref, subPathRaw] = m;
      const subPath = normalizeSubPath(subPathRaw);
      return {
        kind: 'remote',
        displayName: `${owner}/${repo}${ref ? `@${ref}` : ''}${subPath ? `/${subPath}` : ''}`,
        tarball: {
          kind: 'github',
          displayName: `${owner}/${repo}${ref ? `@${ref}` : ''}`,
          owner,
          repo,
          ref: ref || undefined,
          subPath,
        },
        subPath,
        sourceUrl: trimmed,
      };
    }
  }

  // ---------------------------------------------------------------- Bare owner/repo[@ref]
  const shortMatch = trimmed.match(
    /^([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*?)(?:@([\w.\-/]+))?$/,
  );
  if (shortMatch) {
    const [, owner, repo, ref] = shortMatch;
    return {
      kind: 'remote',
      displayName: `${owner}/${repo}${ref ? `@${ref}` : ''}`,
      tarball: {
        kind: 'github',
        displayName: `${owner}/${repo}${ref ? `@${ref}` : ''}`,
        owner,
        repo,
        ref: ref || undefined,
      },
      sourceUrl: trimmed,
    };
  }

  // ---------------------------------------------------------------- Rejected with friendly hints
  if (/^https?:\/\/(?:www\.)?gitlab\.com/i.test(trimmed)) {
    throw new PluginUrlError('暂不支持 GitLab，请使用 GitHub 仓库或直接 zip 下载链接');
  }
  if (/^git@/i.test(trimmed) || /\.git$/i.test(trimmed)) {
    throw new PluginUrlError('暂不支持 SSH/.git 克隆地址，请使用 https://github.com/... 形式');
  }
  if (/^https?:\/\//i.test(trimmed)) {
    throw new PluginUrlError('只支持 github.com 链接、直连 .zip/.tar.gz 文件、或 file:// 本地路径');
  }

  throw new PluginUrlError(
    `无法识别的输入："${trimmed}"。示例：foo/bar、https://github.com/foo/bar、https://example.com/plugin.zip、file:///path/to/plugin`,
  );
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function assertSafeSegment(s: string, field: string): void {
  if (!/^[A-Za-z0-9][\w.-]*$/.test(s) || s.includes('..')) {
    throw new PluginUrlError(`非法的 ${field}："${s}"`);
  }
}

function normalizeSubPath(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.replace(/^\/+|\/+$/g, '');
  if (!trimmed) return undefined;
  if (trimmed.split('/').some(seg => seg === '..' || seg === '')) {
    throw new PluginUrlError(`非法的子路径："${raw}"`);
  }
  return trimmed;
}
