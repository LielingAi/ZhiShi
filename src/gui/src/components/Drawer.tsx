/**
 * 工具输出抽屉（复用 v19：命令 + 高亮输出 + 搜索 + 复制）。
 * 输出高亮：flag{} / SIGSEGV 系 / 0x 地址 / CVE / exit 码 / 常见失败词。
 */

import type React from 'react';

import { useGuiStore } from '../store/useGuiStore';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function highlight(text: string): string {
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

/** 搜索命中包裹 <mark>；没命中返回 undefined。 */
function markMatch(raw: string, query: string): string | undefined {
  const q = query.trim();
  if (!q) return undefined;
  const idx = raw.toLowerCase().indexOf(escapeHtml(q.toLowerCase()));
  if (idx < 0) return undefined;
  const len = escapeHtml(q).length;
  return `${raw.slice(0, idx)}<mark class="h-search">${raw.slice(idx, idx + len)}</mark>${raw.slice(idx + len)}`;
}

export function Drawer(): React.JSX.Element {
  const drawer = useGuiStore((s) => s.drawer);
  const closeDrawer = useGuiStore((s) => s.closeDrawer);
  const setDrawerSearch = useGuiStore((s) => s.setDrawerSearch);
  const showToast = useGuiStore((s) => s.showToast);

  if (!drawer) return <div className="drawer" />;

  const lineCount = drawer.output ? drawer.output.split('\n').length : 0;
  const ok = drawer.state !== 'fail';
  const base = highlight(drawer.output);
  const marked = markMatch(base, drawer.search) ?? base;

  return (
    <div className="drawer open">
      <div className="drawer-head">
        <span>工具输出</span>
        <button className="d-close" onClick={closeDrawer}>✕</button>
      </div>
      <div className="drawer-body">
        <div className="d-head">
          <span className="d-name">{drawer.name}</span>
          <span className={`d-badge ${ok ? 'ok' : 'fail'}`}>
            {ok ? '✔ exit 0' : `✗ ${drawer.exitCode !== undefined ? `exit ${drawer.exitCode}` : '失败'}`}
          </span>
          {drawer.elapsedMs !== undefined && (
            <span className="d-dur">{(drawer.elapsedMs / 1000).toFixed(1)}s</span>
          )}
          <span className="d-lines">{lineCount} 行</span>
        </div>
        {drawer.args && <div className="d-cmd">{drawer.args}</div>}
        {/* 输出已 escapeHtml 后再插 highlight 标签——安全。 */}
        <div className="d-output" dangerouslySetInnerHTML={{ __html: marked }} />
        <div className="d-toolbar">
          <input
            className="d-search"
            placeholder="搜索输出…"
            value={drawer.search}
            onChange={(e) => setDrawerSearch(e.target.value)}
          />
          <button
            className="btn small"
            onClick={() => {
              void navigator.clipboard
                .writeText(drawer.output)
                .then(() => showToast('✓ 输出已复制'))
                .catch(() => showToast('复制失败'));
            }}
          >
            复制
          </button>
        </div>
      </div>
    </div>
  );
}
