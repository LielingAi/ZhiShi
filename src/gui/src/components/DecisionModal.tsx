/**
 * 决策面板模态（1.3.2 ①）——琥珀决策卡：question 主文 → options 列表
 * （a/b/数字快捷键）→ 专家依据区（E#N 徽章 + 文本；「库中无基准」特殊
 * 样式，语义原样）→ 输入为主通道（textarea，Enter 提交，choice 取所填
 * 文本，note 可空）→ a/b/数字键选中选项并可 Enter 提交。
 *
 * 数据源：store.decisions（SSE chat:decision-request 登记）+ activeDecisionId
 * 弹窗指针。重连重放按 decisionId 去重（model/decision.ts upsert 幂等）。
 * Esc 进 Esc 链（decision 层）：收起不作答，decision 保持 pending 缩为
 * 会话头部待答指示（可点开重答）。
 * 提交：POST /chat/decision/respond → 成功 toast + 收起；404/409 提示并
 * 重放刷新 pending 状态（store.respondDecision）。
 */

import { useEffect, useRef, useState } from 'react';
import type React from 'react';

import { useGuiStore } from '../store/useGuiStore';
import { optionHotkey, optionHotkeyIndex, parseExpertHit } from '../model/decision';

export function DecisionModal(): React.JSX.Element | null {
  const activeDecisionId = useGuiStore((s) => s.activeDecisionId);
  const decisions = useGuiStore((s) => s.decisions);
  const respondDecision = useGuiStore((s) => s.respondDecision);
  const dismissDecision = useGuiStore((s) => s.dismissDecision);

  const decision = decisions.find((d) => d.decisionId === activeDecisionId) ?? null;
  const [choice, setChoice] = useState('');
  const [note, setNote] = useState('');
  const [selected, setSelected] = useState<number | null>(null);

  // 换决策时清输入；重连重放的短暂空窗（decision 暂 null）不清草稿——
  // 用 ref 记住上一个非空 decisionId，只有真正切到别的决策才重置。
  const decisionId = decision?.decisionId;
  const lastIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (decisionId && lastIdRef.current !== decisionId) {
      lastIdRef.current = decisionId;
      setChoice('');
      setNote('');
      setSelected(null);
    }
  }, [decisionId]);

  // a/b/数字键选选项（输入框聚焦时不劫持）；Enter（非输入框）提交已选选项。
  useEffect(() => {
    if (!decision) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return; // 全局 Esc 链处理（收起不作答）
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
      const idx = optionHotkeyIndex(e.key);
      if (idx !== null && idx >= 0 && idx < decision.options.length) {
        e.preventDefault();
        setSelected(idx);
        setChoice(decision.options[idx]);
        return;
      }
      if (e.key === 'Enter') {
        const picked = choice.trim() || (selected !== null ? decision.options[selected] : '');
        if (picked) {
          e.preventDefault();
          void respondDecision(decision.decisionId, picked, note.trim() || undefined);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [decision, choice, selected, note, respondDecision]);

  if (!decision) return null;

  const submit = (picked: string) => {
    if (!picked) return;
    void respondDecision(decision.decisionId, picked, note.trim() || undefined);
  };

  return (
    <div className="modal-backdrop decision-backdrop open">
      <div className="modal decision-modal">
        <div className="m-head">
          <span className="m-title">⚖ 需要你的决定</span>
          <span className="m-sub">人工决策 · 回注会话流继续 · 每次提请都重新问</span>
        </div>
        <div className="m-body">
          <div className="dc-question">{decision.question}</div>

          {decision.options.length > 0 && (
            <div className="dc-options">
              {decision.options.map((opt, i) => (
                <div
                  className={`dc-option ${selected === i ? 'sel' : ''}`}
                  key={i}
                  onClick={() => {
                    setSelected(i);
                    setChoice(opt);
                  }}
                >
                  <span className="dc-hotkey">{optionHotkey(i)}</span>
                  <span className="dc-opt-text">{opt}</span>
                </div>
              ))}
            </div>
          )}

          <div className="dc-experts">
            <div className="dc-section-label">专家依据</div>
            {decision.expertHits.length === 0 && (
              <div className="dc-hit no-baseline">⚠ {`库中无基准`}</div>
            )}
            {decision.expertHits.map((line, i) => {
              const hit = parseExpertHit(line);
              if (hit.kind === 'no-baseline') {
                return (
                  <div className="dc-hit no-baseline" key={i}>
                    ⚠ 库中无基准
                  </div>
                );
              }
              return (
                <div className="dc-hit" key={i}>
                  {hit.ref && <span className="dc-badge">{hit.ref}</span>}
                  <span className="dc-hit-text">{hit.text}</span>
                </div>
              );
            })}
          </div>

          <div className="f-label" style={{ marginTop: 10 }}>
            你的决定（choice · 输入为主通道，Enter 提交）
          </div>
          <textarea
            className="f-input dc-input"
            rows={2}
            autoFocus
            placeholder="输入决定，或点上方选项 / a-b-数字键选中"
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit(choice.trim());
              }
            }}
          />
          <div className="f-label">备注（可选 · 留档，可空）</div>
          <input
            className="f-input"
            placeholder="选择理由 / 补充说明"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="m-actions">
            <button className="btn" onClick={() => dismissDecision(decision.decisionId)}>
              稍后（收起为待答指示）
            </button>
            <button
              className="btn primary"
              disabled={!choice.trim() && selected === null}
              onClick={() => submit(choice.trim() || (selected !== null ? decision.options[selected] : ''))}
            >
              提交决定
            </button>
          </div>
          <div className="m-hint">
            Esc 收起（不作答）· Enter 提交 · a/b/数字键选选项 · Shift+Enter 换行
          </div>
        </div>
      </div>
    </div>
  );
}
