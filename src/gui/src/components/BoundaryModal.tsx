/**
 * 越界 ask 模态（1.3.1 ②）——v19 风格：琥珀边框、y/n 按钮 +
 * 自然语言应答输入框（note 为 additive 字段，服务端忽略，见交付报告）。
 *
 * 数据源：store.boundaryAsks（SSE chat:boundary-ask 登记、expired 摘除）。
 * 应答：POST /chat/boundary/respond { askId, approve, note }。
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
          {ask.objects.length > 0 && (
            <div className="bd-objects">
              {ask.objects.map((o, i) => (
                <div className="bd-object" key={`${ask.askId}-${i}`}>
                  <span className="mono">{o}</span>
                </div>
              ))}
            </div>
          )}
          <div className="f-label" style={{ marginTop: 10 }}>
            自然语言应答（可选——批准/拒绝时附上一句话，留档用）
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
