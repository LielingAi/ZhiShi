/**
 * 工具输出抽屉（复用 v19：命令 + 高亮输出 + 搜索 + 复制）。
 * 输出高亮：flag{} / SIGSEGV 系 / 0x 地址 / CVE / exit 码 / 常见失败词；
 * 高亮/搜索定位的纯函数在 model/drawer-highlight.ts（A2-7：搜索先在纯文本
 * 定位再分段渲染，不在高亮后的 HTML 上切片——搜 class 名片段不产破 HTML）。
 */

import type React from 'react';

import { useGuiStore } from '../store/useGuiStore';
import { drawerOutputHtml } from '../model/drawer-highlight';

export function Drawer(): React.JSX.Element {
  const drawer = useGuiStore((s) => s.drawer);
  const closeDrawer = useGuiStore((s) => s.closeDrawer);
  const setDrawerSearch = useGuiStore((s) => s.setDrawerSearch);
  const showToast = useGuiStore((s) => s.showToast);

  if (!drawer) return <div className="drawer" />;

  const lineCount = drawer.output ? drawer.output.split('\n').length : 0;
  const ok = drawer.state !== 'fail';
  const marked = drawerOutputHtml(drawer.output, drawer.search);

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
        {/* 输出已 escapeHtml 后再插 highlight/mark 标签——安全（见 model/drawer-highlight）。 */}
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
