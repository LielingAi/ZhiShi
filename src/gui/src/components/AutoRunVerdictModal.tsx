/**
 * 验收包模态（1.4.1）——auto-run:verdict-requested → 人终审。
 *
 * 结构：验收条件列表 × 证据预检（有/无证据标记 + E#N 引用徽章）→ 模型陈述
 * （哪条证据支撑哪条条件）→ 三按钮「通过 / 继续跑 / 不通过」（→
 * auto-run/verdict { verdict:'pass'|'continue'|'fail', note? }）。
 *
 * 终审权在人：harness 只做证据预检（有/无证据标记由服务端 verdict-requested
 * payload 的 criteriaPrecheck 携带，1.6.0 接线）。Esc 走 Esc 链 verdict 层：
 * 收起不作答，loop 保持 awaiting-verdict，观察卡「待终审」可重开（与决策
 * 模态同族口径）。
 *
 * 1.6.0 语义钉死（设计 §4）：不通过 = 注回修正**续跑**（理由注回 loop 线，
 * 模型修正后再 declare_completion），不是终止——终止只有 Esc/观察卡出口。
 */

import { useEffect, useState } from 'react';
import type React from 'react';

import { useGuiStore } from '../store/useGuiStore';
import { verdictModalOpen } from '../model/auto-run';

export function AutoRunVerdictModal(): React.JSX.Element | null {
  const autoRun = useGuiStore((s) => s.autoRun);
  const verdictDismissed = useGuiStore((s) => s.verdictDismissed);
  const dismissVerdict = useGuiStore((s) => s.dismissVerdict);
  const respondAutoRunVerdict = useGuiStore((s) => s.respondAutoRunVerdict);
  const [busy, setBusy] = useState(false);
  // 1.6.0：终审附注（不通过理由/继续跑补充说明）——随作答传 note，
  // 服务端注回 loop 线供模型修正时读。
  const [note, setNote] = useState('');
  // 组件常驻（收起/作答后 return null 不卸载）——新 verdict 包到达（对象
  // identity 变化）时清空附注，不残留上一条终审的草稿。
  const verdictObj = autoRun?.verdict;
  useEffect(() => setNote(''), [verdictObj]);

  const verdict = autoRun?.verdict;
  // 1.4.6 走查实证：弹窗只在 awaiting-verdict 态出——sidecar 重启后内存
  // runner 消亡的孤儿记录（verdictPackage 残留盘上）不再弹「答不了」的窗。
  // A3-2：判定收口到 verdictModalOpen，与 Esc 链 verdictOpen 同一口径。
  if (!verdict || !verdictModalOpen(autoRun, verdictDismissed)) return null;

  const respond = (v: 'pass' | 'fail' | 'continue') => {
    setBusy(true);
    const trimmed = note.trim();
    void respondAutoRunVerdict(v, trimmed || undefined).finally(() => setBusy(false));
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
                {/* A2-6 配套：refs 可缺席（断线恢复路径无引用数据），按 [] 渲染。 */}
                {(c.refs ?? []).map((r) => (
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

          {/* 1.6.0：不通过理由 / 继续跑补充说明——注回 loop 线（服务端 note）。 */}
          <div className="dc-experts">
            <div className="dc-section-label">终审附注（选填——不通过的理由将注回 loop 线，模型据此修正续跑）</div>
            <textarea
              className="f-input"
              rows={2}
              placeholder="例：条件二缺实跑证据——先补 fuzz 实跑再重新申报"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={busy}
            />
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
            通过 → 完成 + 报告 · 不通过 → 注回修正，loop 续跑 · 继续跑 → 回到运行态 · Esc 收起（不作答）
          </div>
        </div>
      </div>
    </div>
  );
}
