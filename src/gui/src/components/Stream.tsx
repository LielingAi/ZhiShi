/**
 * 会话流（虚拟化块列表，@tanstack/react-virtual）。
 * 动态高度（measureElement）+ 底部吸附（接近底部时新块自动滚到底）。
 */

import { useEffect, useRef } from 'react';
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
    case 'sys':
      return <div className="sys-line">{item.text}</div>;
  }
}

export function Stream(): React.JSX.Element {
  const items = useGuiStore((s) => selectCurrentSession(s).items);
  const parentRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 160,
    overscan: 8,
    getItemKey: (i) => items[i].id,
  });

  const prevCount = useRef(items.length);
  useEffect(() => {
    if (items.length > prevCount.current && stickRef.current && items.length > 0) {
      virtualizer.scrollToIndex(items.length - 1, { align: 'end' });
    }
    prevCount.current = items.length;
  }, [items.length, virtualizer]);

  return (
    <div
      ref={parentRef}
      className="stream"
      onScroll={(e) => {
        const el = e.currentTarget;
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
      }}
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
  );
}
