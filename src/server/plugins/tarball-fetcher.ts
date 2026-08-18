/**
 * tarball-fetcher.ts — Download a GitHub/raw zip and extract it into memory.
 *
 * Responsibilities:
 *   - Fetch via Bun `fetch()` (inherits HTTP_PROXY / NO_PROXY from env)
 *   - Default-branch fallback (try main → master on 404)
 *   - Enforce size / file-count / per-file limits (zip-bomb defense)
 *   - Strip the GitHub-style wrapper root (`<repo>-<ref>/...`) automatically
 *   - Return an in-memory tree {relativePath: Buffer} for downstream extraction
 *
 * Does NOT write to disk — callers are responsible for choosing a target
 * directory and using the existing zip-slip-protected write path in
 * `plugins/installer.ts` (`writeSkillFiles`).
 */

import AdmZip from 'adm-zip';
// Inlined from the removed skills/url-resolver.ts (wave 3b): the skills
// install pipeline is gone; the plugin system still fetches GitHub/raw-zip
// sources through this module, so the source descriptor + codeload URL
// builder live here now.

export interface ResolvedSkillSource {
  /** Discriminator */
  kind: 'github' | 'raw-zip';
  /** Human-readable display for error messages / UI */
  displayName: string;
  /** GitHub owner (undefined for raw-zip) */
  owner?: string;
  /** GitHub repo (undefined for raw-zip) */
  repo?: string;
  /** GitHub ref (branch/tag); undefined means "try default branch" */
  ref?: string;
  /** Subdirectory inside the repo to extract (e.g. "skills/baz") */
  subPath?: string;
  /** Specific skill name hint (from `owner/repo@name` or `--skill name`) */
  skillName?: string;
  /** Already-resolved download URL (only set for raw-zip) */
  rawZipUrl?: string;
}

export class SkillUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillUrlError';
  }
}

/**
 * Build candidate tarball download URLs for a resolved GitHub source.
 *
 * codeload URL forms:
 *   - /zip/refs/heads/<branch>  — branch (explicit)
 *   - /zip/refs/tags/<tag>      — tag (explicit)
 *   - /zip/<ref>                — universal: accepts branches, tags, AND commit
 *                                  SHAs; this is the form codeload itself uses
 *                                  when serving GitHub's "Download ZIP" button
 *
 * Strategy:
 *   - No ref → try /zip/refs/heads/main, then /zip/refs/heads/master
 *     (explicit heads path avoids 302 ambiguity for the fallback case)
 *   - Explicit ref → use the universal /zip/<ref> form. This one call handles
 *     branches (`dev`), tags (`v1.0.0`), and commit SHAs uniformly.
 *
 * Returns an array — caller tries them in order, falling back on 404.
 */
export function buildGithubZipCandidates(src: ResolvedSkillSource): string[] {
  if (src.kind !== 'github' || !src.owner || !src.repo) {
    throw new SkillUrlError('not a github source');
  }
  const base = `https://codeload.github.com/${src.owner}/${src.repo}/zip`;
  if (src.ref) {
    return [`${base}/${encodeURIComponent(src.ref)}`];
  }
  return [`${base}/refs/heads/main`, `${base}/refs/heads/master`];
}

// ---------------------------------------------------------------------------
// Limits (tuned for "pit of success" — refuse anything suspicious by default)
// ---------------------------------------------------------------------------

const MAX_TARBALL_BYTES = 50 * 1024 * 1024; // 50 MB total download
const MAX_FILES_PER_REPO = 2000;             // plenty for 99% of skill repos
const MAX_FILE_BYTES = 5 * 1024 * 1024;      // 5 MB per file (skill assets rarely exceed this)
// 5 min — covers slow CN proxies + ~40-file subdirectory repos which can take
// 30s+ even with `git clone`. Previous value (60s) was the hard cap users hit
// repeatedly (#193). Caller-side budgets (sidecarSelf, Rust proxy) must be ≥ this.
const FETCH_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * In-memory file tree after extraction.
 * Keys are POSIX-style relative paths (no leading slash, no `..`).
 * GitHub's wrapper root (`<repo>-<sha>/`) has been stripped.
 */
export interface ExtractedTree {
  files: Map<string, Buffer>;
  /** Original download URL that actually succeeded (for logging / provenance) */
  sourceUrl: string;
  /** Effective ref used (populated when default-branch fallback was taken) */
  effectiveRef?: string;
}

export class TarballFetchError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = 'TarballFetchError';
    this.statusCode = statusCode;
  }
}

/**
 * Fetch the zip for a resolved skill source and return the extracted tree.
 * Throws TarballFetchError on any HTTP/size/format failure.
 */
export async function fetchSkillZip(src: ResolvedSkillSource): Promise<ExtractedTree> {
  const candidates = src.kind === 'github'
    ? buildGithubZipCandidates(src)
    : [src.rawZipUrl!];

  let lastError: TarballFetchError | null = null;

  for (const url of candidates) {
    try {
      const { buffer, effectiveRef } = await downloadZip(url, src);
      const files = extractZipInMemory(buffer);
      return { files, sourceUrl: url, effectiveRef };
    } catch (err) {
      if (err instanceof TarballFetchError && err.statusCode === 404 && candidates.length > 1) {
        // Default-branch fallback: try next candidate
        lastError = err;
        continue;
      }
      throw err;
    }
  }

  throw lastError ?? new TarballFetchError('No candidate URLs to try', 500);
}

// ---------------------------------------------------------------------------
// SSRF guard — reject any URL host that points at localhost or a private IP
// ---------------------------------------------------------------------------

/**
 * Reject URLs whose host is a literal loopback / RFC1918 / link-local address.
 *
 * This is the classic blind-SSRF shape: user pastes a URL → our server follows
 * it → lands on an internal service. We can't stop DNS rebinding attacks here
 * without resolving ourselves, but we CAN stop the obvious cases.
 *
 * The GitHub path goes through codeload.github.com which is public-only, but
 * the raw-zip passthrough accepts arbitrary user URLs, and redirects during
 * fetch can land anywhere. We validate both the initial URL and every redirect
 * hop.
 */
function assertPublicUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TarballFetchError(`非法 URL：${url}`, 400);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new TarballFetchError(`不支持的协议：${parsed.protocol}`, 400);
  }

  const host = parsed.hostname.toLowerCase();

  // String-match obvious localhost aliases first (catches `localhost`, `::1`, etc.)
  const LOOPBACK_HOSTS = new Set([
    'localhost', '0.0.0.0', '127.0.0.1', '::1', '[::1]', '[::]',
    'ip6-loopback', 'ip6-localhost',
  ]);
  if (LOOPBACK_HOSTS.has(host)) {
    throw new TarballFetchError(`拒绝连接到本地回环地址：${host}`, 400);
  }

  // IPv4 literal (with dotted notation) — check RFC1918 and link-local
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [a, b] = [Number(ipv4Match[1]), Number(ipv4Match[2])];
    if (
      a === 10 ||                                    // 10.0.0.0/8
      (a === 172 && b >= 16 && b <= 31) ||           // 172.16.0.0/12
      (a === 192 && b === 168) ||                    // 192.168.0.0/16
      a === 127 ||                                   // 127.0.0.0/8
      (a === 169 && b === 254) ||                    // 169.254.0.0/16 link-local
      a === 0                                        // 0.0.0.0/8
    ) {
      throw new TarballFetchError(`拒绝连接到私有网络地址：${host}`, 400);
    }
  }

  // IPv6 literal — reject unique local (fc00::/7) and link-local (fe80::/10)
  if (host.startsWith('[fc') || host.startsWith('[fd') || host.startsWith('[fe80:')) {
    throw new TarballFetchError(`拒绝连接到私有 IPv6 地址：${host}`, 400);
  }
}

// ---------------------------------------------------------------------------
// HTTP download with size + timeout enforcement + manual redirect following
// ---------------------------------------------------------------------------

const MAX_REDIRECTS = 5;

async function downloadZip(
  url: string,
  src: ResolvedSkillSource,
): Promise<{ buffer: Buffer; effectiveRef?: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    // Manual redirect loop: every hop is validated against the SSRF guard,
    // so a malicious `302 Location: http://127.0.0.1/…` cannot silently land
    // on an internal service. Bun's native `redirect: 'follow'` gives us no
    // hook into the intermediate URLs, so we do this by hand.
    let currentUrl = url;
    let resp: Response;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      assertPublicUrl(currentUrl);
      resp = await fetch(currentUrl, {
        signal: controller.signal,
        redirect: 'manual',
        headers: {
          'User-Agent': 'ZhiShi-Skill-Installer/1.0',
          'Accept': 'application/zip, application/octet-stream',
        },
      });
      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get('location');
        if (!location) {
          throw new TarballFetchError(`重定向缺少 Location 头：HTTP ${resp.status}`, 502);
        }
        if (hop >= MAX_REDIRECTS) {
          throw new TarballFetchError(`重定向次数过多 (>${MAX_REDIRECTS})`, 508);
        }
        // Resolve relative Location against current URL
        currentUrl = new URL(location, currentUrl).href;
        continue;
      }
      break;
    }
    // At this point resp is the terminal response (`break` above)
    resp = resp!;

    if (!resp.ok) {
      if (resp.status === 404) {
        throw new TarballFetchError(`仓库或分支不存在 (${resp.status})`, 404);
      }
      if (resp.status === 401 || resp.status === 403) {
        throw new TarballFetchError(`无权访问仓库 (${resp.status}) — 暂不支持私有仓库`, resp.status);
      }
      throw new TarballFetchError(`下载失败：HTTP ${resp.status}`, resp.status);
    }

    // Early abort if Content-Length is too big
    const contentLength = resp.headers.get('content-length');
    if (contentLength && Number(contentLength) > MAX_TARBALL_BYTES) {
      throw new TarballFetchError(
        `仓库太大 (${Math.round(Number(contentLength) / 1024 / 1024)} MB > 50 MB)`,
        413,
      );
    }

    const arrayBuffer = await resp.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_TARBALL_BYTES) {
      throw new TarballFetchError(
        `下载体积超限 (${Math.round(arrayBuffer.byteLength / 1024 / 1024)} MB > 50 MB)`,
        413,
      );
    }

    // Determine effective ref from the *initial* URL we were asked to fetch
    // (not the terminal URL after redirects). The caller passed us a codeload
    // URL derived from src.ref via buildGithubZipCandidates.
    const refMatch = url.match(/\/zip\/(?:refs\/(?:heads|tags)\/)?([^/?#]+)$/);
    return {
      buffer: Buffer.from(arrayBuffer),
      effectiveRef: refMatch ? decodeURIComponent(refMatch[1]) : src.ref,
    };
  } catch (err) {
    if (err instanceof TarballFetchError) throw err;
    if ((err as Error).name === 'AbortError') {
      throw new TarballFetchError('下载超时 — 请检查网络或代理配置', 504);
    }
    throw new TarballFetchError(`下载失败：${(err as Error).message}`, 500);
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Zip → in-memory tree, stripping the GitHub wrapper root if present
// ---------------------------------------------------------------------------

function extractZipInMemory(buffer: Buffer): Map<string, Buffer> {
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch (err) {
    throw new TarballFetchError(`无法解压 zip：${(err as Error).message}`, 422);
  }

  const entries = zip.getEntries();
  if (entries.length === 0) {
    throw new TarballFetchError('zip 是空的', 422);
  }
  if (entries.length > MAX_FILES_PER_REPO) {
    throw new TarballFetchError(
      `文件数过多 (${entries.length} > ${MAX_FILES_PER_REPO})`,
      413,
    );
  }

  // Detect single wrapper root (GitHub uses `<repo>-<ref-or-sha>/`)
  const topLevel = new Set<string>();
  for (const entry of entries) {
    const head = entry.entryName.split('/')[0];
    if (head && head !== '__MACOSX') topLevel.add(head);
  }
  const stripRoot = topLevel.size === 1 ? Array.from(topLevel)[0] : null;
  const prefixToStrip = stripRoot ? `${stripRoot}/` : '';

  const files = new Map<string, Buffer>();
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (entry.entryName.startsWith('__MACOSX')) continue;

    let rel = entry.entryName;
    if (prefixToStrip && rel.startsWith(prefixToStrip)) {
      rel = rel.slice(prefixToStrip.length);
    }
    if (!rel) continue;

    // POSIX-normalize and reject any path traversal attempts
    if (rel.includes('..') || rel.startsWith('/')) continue;

    // Per-file size limit
    const data = entry.getData();
    if (data.length > MAX_FILE_BYTES) {
      throw new TarballFetchError(
        `文件过大：${rel} (${Math.round(data.length / 1024 / 1024)} MB > 5 MB)`,
        413,
      );
    }

    files.set(rel, data);
  }

  if (files.size === 0) {
    throw new TarballFetchError('zip 中未找到任何有效文件', 422);
  }

  return files;
}

// Exported for testing
export const _internals = {
  MAX_TARBALL_BYTES,
  MAX_FILES_PER_REPO,
  MAX_FILE_BYTES,
  FETCH_TIMEOUT_MS,
  extractZipInMemory,
};
