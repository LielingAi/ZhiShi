/**
 * 工具卡行（细节区内 / 抽屉入口）。点击打开抽屉（复用 v19 抽屉：
 * 命令 + 高亮输出 + 搜索 + 复制）。运行中显示 spinner。
 */

import type React from 'react';

import { useGuiStore } from '../store/useGuiStore';
import { toolStepChar, type ToolDetail } from '../model/blocks';

export function ToolCard({ detail }: { detail: ToolDetail }): React.JSX.Element {
  const openDrawer = useGuiStore((s) => s.openDrawer);

  return (
    <div
      className="tool-card"
      onClick={() => {
        if (detail.state !== 'running') openDrawer(detail);
      }}
    >
      <span className="t-step">{toolStepChar(detail.step)}</span>
      <span className="t-name">{detail.name}</span>{' '}
      {detail.state === 'running' ? (
        <span className="t-running">
          <span className="spinner" />
          执行中…
        </span>
      ) : detail.state === 'fail' ? (
        <span className="sig fail">✗ {detail.signal ?? '失败'}</span>
      ) : (
        <span className="sig hit">✔ {detail.signal ?? '完成'}</span>
      )}
      {detail.elapsedMs !== undefined && (
        <span className="dur"> · {(detail.elapsedMs / 1000).toFixed(1)}s</span>
      )}
      <span className="open-hint">查看 ▸</span>
    </div>
  );
}
