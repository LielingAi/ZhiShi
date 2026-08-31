/**
 * 会话流（虚拟化块列表，@tanstack/react-virtual）。
 * 动态高度（measureElement）+ 底部吸附（接近底部时新块自动滚到底）。
 */

import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import { selectCurrentSession, useGuiStore } from '../store/useGuiStore';
import type { StreamItem } from '../model/blocks';
import { TurnView } from './TurnView';

function ItemView({ item }: { item: StreamItem }): React.JSX.Element {
  switch (item.kind) {
    case 'turn':
      return <TurnView turn={item} />;
    case 'divider':
      return (
        <div className="divider-line">
          <span>{item.text}</span>
        </div>
      );
    case 'error':
      return (
        <div className="error-line">
          <span className="err-mark">✗</span> {item.text}
        </div>
      );
  }
}

export function Stream(): React.JSX.Element {
  const items = useGuiStore((s) => selectCurrentSession(s).items);
  // 1.4.4 研究档案：档案锚 → 流跳转（一次性信号,按 nonce 消费）。
  const jumpTarget = useGuiStore((s) => s.archiveJumpTarget);
  // 1.5.2：会话身份（切换环境/会话 = 换新 session 槽）——返回时定位到最新。
  const envKey = useGuiStore((s) => s.currentEnvKey);
  const parentRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  // 1.5.2：浮动跳转按钮的状态（非底部出「↓ 最新」、非顶部出「↑ 顶部」）。
  const [atBottom, setAtBottom] = useState(true);
  const [atTop, setAtTop] = useState(true);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 160,
    overscan: 8,
    getItemKey: (i) => items[i].id,
  });

  const syncScrollFlags = (el: HTMLElement) => {
    const bottomGap = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickRef.current = bottomGap < 96;
    setAtBottom(bottomGap < 96);
    setAtTop(el.scrollTop < 48);
  };

  // 档案锚跳流：找包含目标 user 消息 id 的 turn，滚到块首。
  useEffect(() => {
    if (!jumpTarget) return;
    const idx = items.findIndex(
      (i) => i.kind === 'turn' && i.srvIds.includes(jumpTarget.messageId),
    );
    if (idx >= 0) {
      stickRef.current = false;
      virtualizer.scrollToIndex(idx, { align: 'start' });
    }
  }, [jumpTarget?.nonce]);

  // 1.5.2：返回会话自动到最后消息——会话身份变化时定位一次（不跟踪后续
  // 滚动：用户上翻阅读历史不被强拉，吸附语义照旧只管新块）。
  useEffect(() => {
    if (items.length > 0) {
      stickRef.current = true;
      virtualizer.scrollToIndex(items.length - 1, { align: 'end' });
    }
  }, [envKey]);

  const prevCount = useRef(items.length);
  useEffect(() => {
    if (items.length > prevCount.current && stickRef.current && items.length > 0) {
      virtualizer.scrollToIndex(items.length - 1, { align: 'end' });
    }
    prevCount.current = items.length;
  }, [items.length, virtualizer]);

  return (
    <div className="stream-jump-wrap">
      <div
        ref={parentRef}
        className="stream"
        onScroll={(e) => syncScrollFlags(e.currentTarget)}
      >
        {items.length === 0 && (
          <div className="ready-line">
            <span className="ok">◈</span> 等待第一条消息——输入区提问，或从侧栏切换环境
          </div>
        )}
        <div
          className="stream-inner"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
          {virtualizer.getVirtualItems().map((vi) => (
            <div
              key={vi.key}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              className="stream-row"
              style={{ transform: `translateY(${vi.start}px)` }}
            >
              <ItemView item={items[vi.index]} />
            </div>
          ))}
        </div>
      </div>
      {!atTop && items.length > 0 && (
        <button
          className="stream-jump stream-jump-top"
          title="一键最上面"
          onClick={() => {
            stickRef.current = false;
            virtualizer.scrollToIndex(0, { align: 'start' });
          }}
        >
          ↑ 顶部
        </button>
      )}
      {!atBottom && items.length > 0 && (
        <button
          className="stream-jump stream-jump-bottom"
          title="一键最下面（回到最新并恢复底部吸附）"
          onClick={() => {
            stickRef.current = true;
            virtualizer.scrollToIndex(items.length - 1, { align: 'end' });
          }}
        >
          ↓ 最新
        </button>
      )}
    </div>
  );
}
