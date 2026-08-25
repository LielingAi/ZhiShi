/**
 * 越界 ask 模态（1.3.1 ② + 1.3.2 任务二 #1）——v19 风格：琥珀边框、
 * y/n 按钮 + 自然语言应答输入框。1.3.2 起渲染服务端 additive 字段
 * toolName / toolDescription / options（有则显示）；note 被服务端消费并
 * 落盘进 transcript（POST /chat/boundary/respond { askId, approve, note }）。
 *
 * 数据源：store.boundaryAsks（SSE chat:boundary-ask 登记、expired 摘除）。
 * Esc：进 Esc 链（boundary 层，见 model/esc-chain.ts）——收起不作答。
 */

import { useState } from 'react';
import type React from 'react';

import { useGuiStore } from '../store/useGuiStore';
import { boundaryAskMeta } from '../model/boundary';

export function BoundaryModal(): React.JSX.Element | null {
  const ask = useGuiStore((s) => s.boundaryAsks[0] ?? null);
  const respondBoundaryAsk = useGuiStore((s) => s.respondBoundaryAsk);
  const [note, setNote] = useState('');

  if (!ask) return null;
  const meta = boundaryAskMeta(ask.kind);

  const answer = (approve: boolean) => {
    const n = note.trim();
    setNote('');
    void respondBoundaryAsk(ask.askId, approve, n || undefined);
  };

  return (
    <div className="modal-backdrop boundary-backdrop open">
      <div className="modal boundary-modal">
        <div className="m-head">
          <span className="m-title">
            ⚠ {meta.title}
          </span>
          <span className="m-sub">越界 · 每次都要人批准 · 无「永远允许」</span>
        </div>
        <div className="m-body">
          <div className="bd-desc">{meta.desc}</div>
          {/* 1.3.2 任务二 #1：服务端随 payload 给的触发工具名/说明/选项（有则显示） */}
          {ask.toolName && (
            <div className="bd-tool mono">{ask.toolName}</div>
          )}
          {ask.toolDescription && (
            <div className="bd-desc">{ask.toolDescription}</div>
          )}
          {ask.objects.length > 0 && (
            <div className="bd-objects">
              {ask.objects.map((o, i) => (
                <div className="bd-object" key={`${ask.askId}-${i}`}>
                  <span className="mono">{o}</span>
                </div>
              ))}
            </div>
          )}
          {ask.options && ask.options.length > 0 && (
            <div className="bd-options">
              {ask.options.map((o, i) => (
                <span className="bd-option" key={`${ask.askId}-opt-${i}`}>{o}</span>
              ))}
            </div>
          )}
          <div className="f-label" style={{ marginTop: 10 }}>
            自然语言应答（可选——批准/拒绝时附上一句话，留档进 transcript）
          </div>
          <input
            className="f-input"
            placeholder="例如：确认这是本轮提取的 flag.txt"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="m-actions">
            <button className="btn" onClick={() => answer(false)}>
              ✗ {meta.denyLabel}
            </button>
            <button className="btn primary" onClick={() => answer(true)}>
              ✓ {meta.approveLabel}
            </button>
          </div>
          <div className="m-hint">Esc 收起（不作答）· 5 分钟未应答自动拒绝</div>
        </div>
      </div>
    </div>
  );
}
