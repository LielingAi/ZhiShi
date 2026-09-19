/**
 * auto loop 模态组（1.4.1；1.7.7 收敛）：
 *   - AutoRunStartModal（modal kind 'auto-run-start'）：启动表单——任务名 /
 *     环境（store 当前环境，启动即锁定）/ 目标 / 预算三选一（轮次/token/
 *     时间，默认轮次 50）/ 验收条件动态列表（「+ 添加条件」，≥1 条）/
 *     可选空转推进话术（折叠输入，留空 = 内置默认话术，'off' = 关闭）。
 *     提交 → auto-run/start（store.submitAutoRun）。
 *   - AutoRunStopModal（modal kind 'auto-run-stop'）：Esc 终止的二次确认
 *     小模态（防误触）。
 *
 * 1.7.7：无策略文件、无快照/报告开关、无暂停点/终审——表单就是三输入 +
 * 可选话术；校验在 model/auto-run.ts::validateAutoRunForm（纯函数 + 单测），
 * 本组件只做表单状态与接线；样式复用 Modal 体系的 m-* / f-* / btn 类。
 */

import { useState } from 'react';
import type React from 'react';

import { useGuiStore } from '../store/useGuiStore';
import {
  BUDGET_KIND_LABELS,
  DEFAULT_BUDGET_LIMITS,
  parseBudgetLimit,
  validateAutoRunForm,
  type AutoRunBudgetKind,
} from '../model/auto-run';

const BUDGET_KINDS: AutoRunBudgetKind[] = ['turns', 'tokens', 'time'];

function AutoRunStartModal(): React.JSX.Element | null {
  const currentEnvKey = useGuiStore((s) => s.currentEnvKey);
  const closeModal = useGuiStore((s) => s.closeModal);
  const submitAutoRun = useGuiStore((s) => s.submitAutoRun);

  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [budgetKind, setBudgetKind] = useState<AutoRunBudgetKind>('turns');
  const [budgetLimit, setBudgetLimit] = useState(String(DEFAULT_BUDGET_LIMITS.turns));
  const [criteria, setCriteria] = useState<string[]>(['']);
  const [stallPrompt, setStallPrompt] = useState('');
  const [stallOpen, setStallOpen] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const pickBudgetKind = (kind: AutoRunBudgetKind) => {
    setBudgetKind(kind);
    setBudgetLimit(String(DEFAULT_BUDGET_LIMITS[kind]));
  };

  const setCriterion = (i: number, v: string) =>
    setCriteria((cs) => cs.map((c, idx) => (idx === i ? v : c)));
  const removeCriterion = (i: number) =>
    setCriteria((cs) => (cs.length > 1 ? cs.filter((_, idx) => idx !== i) : cs));
  const addCriterion = () => setCriteria((cs) => [...cs, '']);

  // 1.4.1 用户拍板：环境 = 当前环境，不可选。无当前环境（host）→ 整表单不可提交。
  const envKey = currentEnvKey;
  const noEnv = !envKey;

  const submit = () => {
    const errors = validateAutoRunForm(
      { name, envKey: envKey ?? '', goal, budgetKind, budgetLimit, criteria, stallPrompt },
      [],
    );
    if (errors.length > 0) {
      setErr(errors[0].message);
      return;
    }
    setErr('');
    setBusy(true);
    void submitAutoRun({ name, envKey: envKey ?? '', goal, budgetKind, budgetLimit, criteria, stallPrompt }).finally(() =>
      setBusy(false),
    );
  };

  return (
    <div className="modal-backdrop open">
      <div className="modal ar-start-modal">
        <div className="m-head">
          <span className="m-title">⚡ 启动 auto loop</span>
          <span className="m-sub">目标式研究循环 · 启动即锁定 · 运行中仅观察</span>
          <button className="m-close" onClick={closeModal}>✕</button>
        </div>
        <div className="m-body">
          <div className="form-col">
            <div>
              <div className="f-label">任务名（必填 · 列表/观察卡标识）</div>
              <input
                className="f-input"
                placeholder="一句话摘要"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <div className="f-label">环境（当前环境 · 启动即锁定，运行中不可换）</div>
              {noEnv ? (
                <div className="m-note">当前未选环境——先在侧栏选择环境（一切操作都在环境内）</div>
              ) : (
                <div className="ar-env-locked">🔒 {envKey}</div>
              )}
            </div>
            <div>
              <div className="f-label">目标（必填 · 驱动循环的锚）</div>
              <textarea
                className="f-input"
                rows={2}
                placeholder="要达成什么的陈述"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
              />
            </div>
          </div>

          <div className="f-label" style={{ marginTop: 10 }}>预算（三选一 · 默认保守 · 强制超时封顶）</div>
          <div className="ar-budget-row">
            {BUDGET_KINDS.map((k) => (
              <label className="ar-radio" key={k}>
                <input
                  type="radio"
                  name="budget-kind"
                  checked={budgetKind === k}
                  onChange={() => pickBudgetKind(k)}
                />
                {BUDGET_KIND_LABELS[k]}
              </label>
            ))}
            <input
              className="f-input ar-budget-limit"
              value={budgetLimit}
              onChange={(e) => setBudgetLimit(e.target.value)}
              placeholder={String(DEFAULT_BUDGET_LIMITS[budgetKind])}
            />
          </div>
          {budgetKind === 'tokens' && <div className="m-note">tokens 按 K/M 计（如 8000000 = 8M）</div>}

          <div className="f-label" style={{ marginTop: 10 }}>
            验收条件（必填 ≥1 条 · 每条一条可验证陈述 · 启动即锁定，agent 不可改 · 任一达成即完成）
          </div>
          <div className="ar-crit-list">
            {criteria.map((c, i) => (
              <div className="ar-crit-row" key={i}>
                <input
                  className="f-input"
                  placeholder="如：输出 flag{…} / PoC 连续 3 次稳定复现"
                  value={c}
                  onChange={(e) => setCriterion(i, e.target.value)}
                />
                <button
                  className="btn small"
                  title="移除该条件"
                  onClick={() => removeCriterion(i)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <button className="btn small" onClick={addCriterion}>＋ 添加条件</button>

          <div className="f-label" style={{ marginTop: 10 }}>
            空转推进话术（可选 · 折叠）
            <button className="btn small" style={{ marginLeft: 8 }} onClick={() => setStallOpen((v) => !v)}>
              {stallOpen ? '收起' : '展开'}
            </button>
          </div>
          {stallOpen && (
            <div className="form-col">
              <textarea
                className="f-input"
                rows={3}
                placeholder="留空 = 内置默认话术（区分死路与墙）；填 off = 关闭注入，纯继续；或自定义一段推进话术"
                value={stallPrompt}
                onChange={(e) => setStallPrompt(e.target.value)}
              />
              <div className="m-note">空转（连续 3 轮无新增有效研究记录且阶段未推进）时作为系统消息注入下一轮；不暂停、不问人。</div>
            </div>
          )}

          {err && <div className="m-error">✗ {err}</div>}
          <div className="m-hint">
            启动即锁定：环境/验收条件不可改 · 每轮自动继续 · 停点只有达成 / 预算耗尽 / Esc / provider 连击 5 次 · 结束后看轨迹与研究档案
          </div>
          <div className="m-actions">
            <button className="btn" onClick={closeModal}>取消</button>
            <button
              className="btn primary"
              disabled={busy || noEnv || parseBudgetLimit(budgetLimit) === null}
              onClick={submit}
            >
              启动
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AutoRunStopModal(): React.JSX.Element | null {
  const autoRun = useGuiStore((s) => s.autoRun);
  const closeModal = useGuiStore((s) => s.closeModal);
  const confirmStopAutoRun = useGuiStore((s) => s.confirmStopAutoRun);
  const [busy, setBusy] = useState(false);

  if (!autoRun) return null;

  return (
    <div className="modal-backdrop open">
      <div className="modal">
        <div className="m-head">
          <span className="m-title">终止 auto loop？</span>
          <span className="m-sub">auto-run/stop · 二次确认（Esc 防误触）</span>
          <button className="m-close" onClick={closeModal}>✕</button>
        </div>
        <div className="m-body">
          <div className="wiz-confirm-row">
            <span className="wc-label">任务</span>
            <span className="wc-value">{autoRun.name}</span>
          </div>
          <div className="m-danger">
            终止后 loop 结束、会话回到普通模式——已有产出保留在轨迹与研究档案；
            进行中的研究轮次会被丢弃。
          </div>
          <div className="m-actions">
            <button className="btn" onClick={closeModal}>取消（继续跑）</button>
            <button
              className="btn danger"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void confirmStopAutoRun().finally(() => setBusy(false));
              }}
            >
              终止 loop
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AutoRunModal(): React.JSX.Element | null {
  const modal = useGuiStore((s) => s.modal);
  if (!modal) return null;
  switch (modal.kind) {
    case 'auto-run-start':
      return <AutoRunStartModal />;
    case 'auto-run-stop':
      return <AutoRunStopModal />;
    default:
      return null;
  }
}
