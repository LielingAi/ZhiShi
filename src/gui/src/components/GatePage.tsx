/**
 * 正门（V4-S4 决策①④ → S4.1 全幅启动台）：EnvSidebar 完全退出常驻 chrome
 * 后的唯一环境管理面。组件本体（三组分组/准入闸/⋯菜单/镜像行/新建/设置）
 * 继续零改动——外壳 + 布局 CSS 解决版面饱满度（WREN 真机反馈：居中窄列
 * 留白太多）：
 *
 *   横幅带：品牌 + 大标题 + 环境计数/日期 + 主按钮「＋新建环境」+
 *           「→ 进入工作区」（有环境时）
 *   台账条：2.0-M1——同名重复登记发现（fuzz 双条目这类历史脏账）→
 *           每组给「合并」入口（type-name 确认后走 environment/merge，
 *           只摘登记不删底层实体）
 *   中部：  EnvSidebar 原样挂载——.eb-scroll 在 gate 上下文被改写成
 *           响应式网格（auto-fit minmax 340px），每组一张横铺卡片
 *   底部：  操作提示条（照实际入口写）+ EnvSidebar 自带底栏（新建/设置）
 */

import { useEffect, useState } from 'react';
import type React from 'react';

import { useGuiStore } from '../store/useGuiStore';
import { findNameDuplicates, type NameDupGroup } from '../model/envs';
import { EnvSidebar } from './EnvSidebar';

/** 横幅右侧的本地时钟（M-D HH:MM，1s tick——与工作区 menubar 时钟同族）。 */
function GateClock(): React.JSX.Element {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    <span className="gate-meta" title="环境总数 · 本地时间">
      {now.getMonth() + 1}-{now.getDate()} {pad(now.getHours())}:{pad(now.getMinutes())}
    </span>
  );
}

/** 合并确认目标（type-name 确认后执行）。 */
interface MergeTarget {
  group: NameDupGroup;
  keepId: string;
  dropId: string;
}

/** 同名台账条 + 合并确认（2.0-M1 P5a）。合并是摘登记级破坏动作——
 *  沿用环境删除的 type-name 确认纪律（D14 家族），不做一键静默合并。 */
function GateDups(): React.JSX.Element | null {
  const envs = useGuiStore((s) => s.envs);
  const running = useGuiStore((s) => s.running);
  const mergeEnv = useGuiStore((s) => s.mergeEnv);
  const [target, setTarget] = useState<MergeTarget | null>(null);
  const [typed, setTyped] = useState('');

  // ps 行 id 与登记条目 id 同口径（psRowMatchesEntry 的前提），直接取运行 id 集。
  const dups = findNameDuplicates(envs, running.map((r) => r.id));
  if (dups.length === 0) return null;

  const confirm = async () => {
    if (!target || typed.trim() !== target.group.name) return;
    await mergeEnv(target.keepId, target.dropId);
    setTarget(null);
    setTyped('');
  };

  return (
    <div className="gate-dups">
      <div className="gate-dups-head">
        台账 · 发现 {dups.length} 组同名环境（历史重复登记）——合并 = 保留一条、
        摘除另一条的登记并迁移线映射，<b>不删容器/VM 实体</b>
      </div>
      {dups.map((g) => (
        <div className="gate-dup-group" key={g.name}>
          <span className="gate-dup-name">{g.name}</span>
          <span className="gate-dup-members">
            {g.members.map((m) => (
              <code key={m.id} className={m.id === g.suggestKeepId ? 'gate-dup-keep' : ''}>
                {m.id}
              </code>
            ))}
          </span>
          <button
            className="btn small"
            onClick={() =>
              setTarget({
                group: g,
                keepId: g.suggestKeepId,
                dropId: g.members.find((m) => m.id !== g.suggestKeepId)!.id,
              })
            }
          >
            合并 → 保留 {g.suggestKeepId}
          </button>
        </div>
      ))}

      {target && (
        <div className="modal-backdrop open gate-merge-backdrop">
          <div className="modal gate-merge-modal">
            <div className="modal-title">合并同名环境</div>
            <div className="f-hint">
              保留 <code>{target.keepId}</code>，合并 <code>{target.dropId}</code> 的线映射后
              摘除其登记。容器/VM 实体不动，归保留条目继续使用。
            </div>
            <div className="f-row">
              <input
                className="f-input"
                placeholder={`输入环境名「${target.group.name}」确认`}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void confirm();
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    setTarget(null);
                    setTyped('');
                  }
                }}
              />
            </div>
            <div className="f-actions">
              <button
                className="btn danger"
                disabled={typed.trim() !== target.group.name}
                onClick={() => void confirm()}
              >
                合并
              </button>
              <button
                className="btn"
                onClick={() => {
                  setTarget(null);
                  setTyped('');
                }}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 2.0-M1 僵尸清理（P5c）：横幅「清理」入口 → 候选勾选模态。
 *  候选由服务端 prune/list 保守筛选（已停止+零使用痕迹+非占用+探活排除），
 *  这里只做"人勾选 + 明确确认"（D14：破坏动作的最后仲裁在人）。 */
function GatePrune(): React.JSX.Element {
  const fetchPruneCandidates = useGuiStore((s) => s.fetchPruneCandidates);
  const applyPrune = useGuiStore((s) => s.applyPrune);
  const [open, setOpen] = useState(false);
  const [candidates, setCandidates] = useState<import('../client/api').PruneCandidate[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);

  const showModal = async () => {
    setOpen(true);
    setTyped('');
    setChecked(new Set());
    setCandidates(null);
    const list = await fetchPruneCandidates();
    setCandidates(list);
  };

  const toggle = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const confirm = async () => {
    if (typed.trim() !== 'prune' || checked.size === 0 || busy) return;
    setBusy(true);
    await applyPrune([...checked]);
    setBusy(false);
    setOpen(false);
  };

  return (
    <>
      <button className="btn small" title="僵尸清理：已停止且零使用痕迹的环境" onClick={() => void showModal()}>
        清理
      </button>
      {open && (
        <div className="modal-backdrop open gate-merge-backdrop">
          <div className="modal gate-merge-modal">
            <div className="modal-title">清理台账 · 僵尸环境</div>
            <div className="f-hint">
              候选 = <b>已停止 + 零使用痕迹（无分线映射/无活跃任务）+ 非占用</b>；
              探活失败一律不进候选。删除走完整环境删除语义，请勾选后确认。
            </div>
            {candidates === null && <div className="f-hint">拉取候选…</div>}
            {candidates !== null && candidates.length === 0 && (
              <div className="f-hint">没有僵尸环境——台账干净。</div>
            )}
            {candidates !== null && candidates.length > 0 && (
              <div className="gate-prune-list">
                {candidates.map((c) => (
                  <label className="gate-prune-row" key={c.id}>
                    <input type="checkbox" checked={checked.has(c.id)} onChange={() => toggle(c.id)} />
                    <code>{c.id}</code>
                    <span className="gate-prune-meta">
                      {c.kind}
                      {c.detail ? ` · ${c.detail}` : ''} · {c.reason}
                    </span>
                  </label>
                ))}
              </div>
            )}
            <div className="f-row">
              <input
                className="f-input"
                placeholder="输入 prune 确认删除勾选项"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void confirm();
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    setOpen(false);
                  }
                }}
              />
            </div>
            <div className="f-actions">
              <button
                className="btn danger"
                disabled={typed.trim() !== 'prune' || checked.size === 0 || busy}
                onClick={() => void confirm()}
              >
                删除勾选（{checked.size}）
              </button>
              <button className="btn" onClick={() => setOpen(false)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export function GatePage(): React.JSX.Element {
  const currentEnvKey = useGuiStore((s) => s.currentEnvKey);
  const envCount = useGuiStore((s) => s.envs.length);
  const setPage = useGuiStore((s) => s.setPage);
  const openNewEnv = useGuiStore((s) => s.openNewEnv);

  return (
    <div className="gate-wrap">
      <header className="gate-banner">
        <div className="gate-brand">
          <span className="gate-logo">◣ zhishi</span>
          <span className="gate-heading">选择工作环境</span>
          <span className="gate-sub">
            研究只发生在环境内——选中即进工作区；中途换环境走 Ctrl+K → use
          </span>
        </div>
        <div className="gate-banner-right">
          <span className="gate-meta">环境 {envCount} ·</span>
          <GateClock />
          {currentEnvKey && (
            <button
              className="btn small gate-enter"
              title="回当前环境的工作区（Esc 同语义）"
              onClick={() => setPage('chat')}
            >
              → 进入工作区（{currentEnvKey}）
            </button>
          )}
          {/* 正门第一动作：新建环境——主按钮放在横幅带右侧（底栏的同名
              入口组件自带，两处不算重复：底栏是列表收尾，横幅是着陆第一动作）。 */}
          <button className="btn primary" onClick={() => openNewEnv()}>
            ＋ 新建环境
          </button>
          <GatePrune />
        </div>
      </header>
      <GateDups />
      <div className="gate-col">
        <EnvSidebar />
      </div>
      <footer className="gate-foot">
        <span>点行即进工作区 · 行尾 ⋯ 菜单 = 启停 / 重建 / 重置 / 补齐 / 详情 / 删除</span>
        <span>Ctrl+K → use 切环境 · /gate 唤正门 · Esc 返回</span>
      </footer>
    </div>
  );
}
