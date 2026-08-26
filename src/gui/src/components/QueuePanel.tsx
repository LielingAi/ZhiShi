/**
 * /queue 面板（1.3.1 ④，overlay 形态）：服务端 FIFO/steering 队列
 * （GET /chat/queue/status）+ 取消（POST /chat/queue/cancel）。
 * Esc 进 Esc 链（close-queue 层）。
 */

import type React from 'react';

import { useGuiStore } from '../store/useGuiStore';

export function QueuePanel(): React.JSX.Element | null {
  const open = useGuiStore((s) => s.queueOpen);
  const items = useGuiStore((s) => s.queueServer);
  const cancelQueueItem = useGuiStore((s) => s.cancelQueueItem);
  const closeQueuePanel = useGuiStore((s) => s.closeQueuePanel);

  if (!open) return null;

  return (
    <div className="overlay-backdrop tasks-backdrop open">
      <div className="overlay-panel tasks-panel">
        <div className="overlay-title">
          排队消息（FIFO / steering）
          <button className="tp-close" onClick={closeQueuePanel}>
            ✕
          </button>
        </div>
        <div className="overlay-list tp-list">
          {items.length === 0 && <div className="ov-empty">队列为空</div>}
          {items.map((q) => (
            <div className="tp-item server" key={q.id}>
              <span className="tp-status">{q.kind === 'steering' ? '纠偏' : 'FIFO'}</span>
              <div className="tp-mid">
                <div className="tp-name">{q.messagePreview}</div>
                <div className="tp-detail mono">{q.id}</div>
              </div>
              <button
                className="btn small"
                onClick={() => void cancelQueueItem(q.id)}
                title="取消该排队消息"
              >
                取消
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
