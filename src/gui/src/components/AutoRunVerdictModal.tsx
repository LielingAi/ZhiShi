/**
 * 验收包模态（1.4.1）——auto-run:verdict-requested → 人终审。
 *
 * 结构：验收条件列表 × 证据预检（有/无证据标记 + E#N 引用徽章）→ 模型陈述
 * （哪条证据支撑哪条条件）→ 三按钮「通过 / 继续跑 / 不通过」（→
 * auto-run/verdict { verdict:'pass'|'continue'|'fail' }）。
 *
 * 终审权在人：harness 只做证据预检（有/无证据标记由服务端 verdict-requested
 * payload 的 criteria[] 携带）。Esc 走 Esc 链 verdict 层：收起不作答，loop
 * 保持 awaiting-verdict，观察卡「待终审」可重开（与决策模态同族口径）。
 */

import { useState } from 'react';
import type React from 'react';

import { useGuiStore } from '../store/useGuiStore';

export function AutoRunVerdictModal(): React.JSX.Element | null {
  const autoRun = useGuiStore((s) => s.autoRun);
  const verdictDismissed = useGuiStore((s) => s.verdictDismissed);
  const dismissVerdict = useGuiStore((s) => s.dismissVerdict);
  const respondAutoRunVerdict = useGuiStore((s) => s.respondAutoRunVerdict);
  const [busy, setBusy] = useState(false);

  const verdict = autoRun?.verdict;
  if (!verdict || verdictDismissed) return null;

  const respond = (v: 'pass' | 'fail' | 'continue') => {
    setBusy(true);
    void respondAutoRunVerdict(v).finally(() => setBusy(false));
  };

  return (
    <div className="modal-backdrop decision-backdrop open">
      <div className="modal decision-modal vc-modal">
        <div className="m-head">
          <span className="m-title">⚖ auto loop 验收终审</span>
          <span className="m-sub">
            人终审 · 条件人定且不可变 · 证据预检（引用 E#N 口径）
          </span>
        </div>
        <div className="m-body">
          {autoRun && <div className="dc-question">{autoRun.name}</div>}

          <div className="dc-experts">
            <div className="dc-section-label">验收条件 × 证据预检</div>
            {verdict.criteria.length === 0 && (
              <div className="dc-hit no-baseline">⚠ 服务端未回传验收条件——按启动表单条件终审</div>
            )}
            {verdict.criteria.map((c, i) => (
              <div className={`vc-crit ${c.hasEvidence ? 'has' : 'none'}`} key={i}>
                <span className="vc-mark">{c.hasEvidence ? '✓' : '✗'}</span>
                <span className="vc-crit-text">{c.text}</span>
                <span className="vc-crit-tag">{c.hasEvidence ? '有证据' : '无证据'}</span>
                {c.refs.map((r) => (
                  <span className="dc-badge" key={r}>{r}</span>
                ))}
              </div>
            ))}
          </div>

          <div className="dc-experts">
            <div className="dc-section-label">模型陈述（哪条证据支撑哪条条件）</div>
            <div className="vc-statement">
              {verdict.statement || '（无陈述——请按条件与证据自行终审）'}
            </div>
          </div>

          <div className="m-actions">
            <button className="btn" onClick={dismissVerdict} disabled={busy}>
              稍后（收起为待终审）
            </button>
            <button className="btn" onClick={() => respond('continue')} disabled={busy}>
              继续跑
            </button>
            <button className="btn danger" onClick={() => respond('fail')} disabled={busy}>
              不通过
            </button>
            <button className="btn primary" onClick={() => respond('pass')} disabled={busy}>
              通过
            </button>
          </div>
          <div className="m-hint">
            通过 → 完成 + 报告 · 不通过 → 终止 loop · 继续跑 → 回到运行态 · Esc 收起（不作答）
          </div>
        </div>
      </div>
    </div>
  );
}
