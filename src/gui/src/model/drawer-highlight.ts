/**
 * 工具输出抽屉的高亮与搜索定位（纯函数，1.5.4 从 components/Drawer.tsx 抽出）。
 *
 * 关键纪律（A2-7 修复）：搜索定位**必须先在纯文本上做**——历史上在高亮后
 * 的 HTML 上 indexOf 切片，搜 "flag"/"hl"/"span" 会命中 hl-flag 等 class 名，
 * 截断标签产出破 HTML。现在 locateMatch 只认原始输出文本，渲染时按
 * [前段, 命中段, 后段] 分别高亮再拼 mark，标签边界永不跨段切开。
 */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 输出高亮：flag{} / SIGSEGV 系 / 0x 地址 / CVE / exit 码 / 常见失败词。 */
export function highlight(text: string): string {
  let html = escapeHtml(text);
  html = html.replace(/(flag\{[^}]*\})/gi, '<span class="hl-flag">$1</span>');
  html = html.replace(
    /(SIGSEGV|SIGABRT|SIGILL|Segmentation fault|core dumped)/gi,
    '<span class="hl-red">$1</span>',
  );
  html = html.replace(/(0x[0-9a-fA-F]+)/g, '<span class="hl-cyan">$1</span>');
  html = html.replace(/(CVE-\d{4}-\d+)/gi, '<span class="hl-amber">$1</span>');
  html = html.replace(/(\d+\/tcp\s+open)/gi, '<span class="hl-green">$1</span>');
  html = html.replace(
    /\b(error|failed|denied|timed out|refused)\b/gi,
    '<span class="hl-red">$1</span>',
  );
  return html;
}

export interface MatchSegments {
  before: string;
  match: string;
  after: string;
}

/** 纯文本上定位首个命中（不区分大小写）；没命中返回 undefined。 */
export function locateMatch(raw: string, query: string): MatchSegments | undefined {
  const q = query.trim();
  if (!q) return undefined;
  const idx = raw.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return undefined;
  return { before: raw.slice(0, idx), match: raw.slice(idx, idx + q.length), after: raw.slice(idx + q.length) };
}

/** 抽屉输出最终 HTML：有命中则命中段裹 <mark>（段内不再叠高亮），无命中整段高亮。 */
export function drawerOutputHtml(raw: string, query: string): string {
  const seg = locateMatch(raw, query);
  if (!seg) return highlight(raw);
  return `${highlight(seg.before)}<mark class="h-search">${escapeHtml(seg.match)}</mark>${highlight(seg.after)}`;
}
