/**
 * 决策面板模态（1.3.2 ①，1.4.1 卡片化改版）——琥珀决策卡：question 主文 →
 * **选项卡片（点击即拍板）** → 专家依据区（E#N 徽章 + 文本；「库中无基准」
 * 特殊样式，语义原样）→ 自定义应答（折叠，textarea 次要通道）→ 备注（可选）。
 *
 * 1.4.1 用户反馈：「还是会出现让用户选择输入选择，而不是选择卡片」——
 * 选项从「选中 + 提交」两步改为**卡片单击即提交**；输入降级为折叠的
 * 自定义通道（选项给不出想要的答案时才展开），autofocus 落到第一个选项卡。
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
  const [customOpen, setCustomOpen] = useState(false);
  const [choice, setChoice] = useState('');
  const [note, setNote] = useState('');
  const optionRef = useRef<HTMLButtonElement | null>(null);

  // 换决策时清输入；重连重放的短暂空窗（decision 暂 null）不清草稿——
  // 用 ref 记住上一个非空 decisionId，只有真正切到别的决策才重置。
  const decisionId = decision?.decisionId;
  const lastIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (decisionId && lastIdRef.current !== decisionId) {
      lastIdRef.current = decisionId;
      setChoice('');
      setNote('');
      setCustomOpen(false);
    }
  }, [decisionId]);

  // 聚焦第一个选项卡（卡片为主通道）。
  useEffect(() => {
    if (decision && optionRef.current) optionRef.current.focus();
  }, [decisionId, decision]);

  // a/b/数字键 = 点击对应卡片（即拍板）；输入框聚焦时不劫持。
  useEffect(() => {
    if (!decision) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return; // 全局 Esc 链处理（收起不作答）
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
      const idx = optionHotkeyIndex(e.key);
      if (idx !== null && idx >= 0 && idx < decision.options.length) {
        e.preventDefault();
        void respondDecision(decision.decisionId, decision.options[idx], note.trim() || undefined);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [decision, note, respondDecision]);

  if (!decision) return null;

  const submitCustom = () => {
    const picked = choice.trim();
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
                <button
                  className="dc-option"
                  key={i}
                  ref={i === 0 ? optionRef : undefined}
                  onClick={() => {
                    void respondDecision(decision.decisionId, opt, note.trim() || undefined);
                  }}
                >
                  <span className="dc-hotkey">{optionHotkey(i)}</span>
                  <span className="dc-opt-text">{opt}</span>
                </button>
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

          <button className="btn small dc-custom-toggle" onClick={() => setCustomOpen((v) => !v)}>
            {customOpen ? '收起自定义应答' : '选项都不对——自定义应答'}
          </button>
          {customOpen && (
            <>
              <textarea
                className="f-input dc-input"
                rows={2}
                placeholder="输入你的决定（Enter 提交）"
                value={choice}
                onChange={(e) => setChoice(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    submitCustom();
                  }
                }}
              />
            </>
          )}

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
            {customOpen && (
              <button className="btn primary" disabled={!choice.trim()} onClick={submitCustom}>
                提交决定
              </button>
            )}
          </div>
          <div className="m-hint">
            点卡片即拍板 · a/b/数字键等价 · Esc 收起（不作答）
          </div>
        </div>
      </div>
    </div>
  );
}
