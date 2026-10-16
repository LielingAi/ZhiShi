/**
 * V4-S1 menubar（设计稿 §2 目标骨架第一行，~30px 细栏）——原 Toolbar 的
 * 提取与收编：
 *
 *   左：◣ zhishi 身份 · 当前线 id + 共享徽章（line/list active 行）·
 *       mission 徽章 + 形态选择器（从 Toolbar 上移）
 *   中：原 Toolbar 其余按钮原样保留（历史/auto loop/决策待答/连接错误+重试）
 *       ——S4 才迁走；「研究」V4-S2 起开 SidePane「档案」页签，一颗不丢
 *       （决策②修订：宽屏分屏退役后不再有 flash 分支，宽窄同行为）
 *   右：系统计量（上下文 % / tokens / env / 本地时钟 1s tick）
 *
 * 环境锚（原 at-env 段）折进右侧 env 计量；连接失败的红字 + 重试保持在
 * 中段原位置。线 id 不再等面板打开——连接 live 且清单为空时惰性拉一次
 * line/list（menubar 是线的身份展示区）。
 */

import { useEffect, useState } from 'react';
import type React from 'react';

import { selectCurrentSession, useGuiStore } from '../store/useGuiStore';
import { hostAnchorLabel } from '../model/access-gate';
import { archiveBadgeCount } from '../model/archive';
import { formatTokens, isAutoRunActive } from '../model/auto-run';
import { missionLabel, missionPatchValue, MISSION_OPTIONS } from '../model/mission';
import { shortLineId } from '../model/lines';
import type { StreamItem } from '../model/blocks';

/** 会话内全部已完成 turn 的 token 累计（无 meta 的块跳过——旧会话 replay 无 usage）。 */
function sessionTokensUsed(items: StreamItem[]): number {
  let total = 0;
  for (const it of items) {
    if (it.kind === 'turn' && it.meta) total += it.meta.inputTokens + it.meta.outputTokens;
  }
  return total;
}

/** 本地时钟（HH:MM:SS，1s tick；系统计量段最右位）。 */
function MenubarClock(): React.JSX.Element {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    <span className="mb-meter mb-clock" title="本地时间">
      {pad(now.getHours())}:{pad(now.getMinutes())}:{pad(now.getSeconds())}
    </span>
  );
}

export function Menubar(): React.JSX.Element {
  const session = useGuiStore(selectCurrentSession);
  const envKey = useGuiStore((s) => s.currentEnvKey);
  const connectionState = useGuiStore((s) => s.connectionState);
  const connectError = useGuiStore((s) => s.connectError);
  const init = useGuiStore((s) => s.init);
  const setPage = useGuiStore((s) => s.setPage);
  const decisions = useGuiStore((s) => s.decisions);
  const activeDecisionId = useGuiStore((s) => s.activeDecisionId);
  const openDecision = useGuiStore((s) => s.openDecision);
  const openHistoryPanel = useGuiStore((s) => s.openHistoryPanel);
  const autoRunActive = useGuiStore((s) => isAutoRunActive(s.autoRun));
  const openAutoRunStart = useGuiStore((s) => s.openAutoRunStart);
  // 1.4.4 研究档案：决策②修订（V4-S3）——档案唯一落位 SidePane「档案」页签，
  // 宽窄同行为：点击即开页签（未决问题 + 待复核徽章保留）。
  const archive = useGuiStore((s) => s.archive);
  const openSidePane = useGuiStore((s) => s.openSidePane);
  const archiveBadge = archiveBadgeCount(archive);
  // 1.6.11：任务形态（挂会话线，线态直读/直设）——选择器设/清，徽章显当前形态（无类型不显）。
  const mission = useGuiStore((s) => s.mission);
  const setMission = useGuiStore((s) => s.setMission);
  // 当前线（line/list active 行）+ 惰性补拉：menubar 是线的身份展示区。
  const lines = useGuiStore((s) => s.lines);
  const refreshLines = useGuiStore((s) => s.refreshLines);

  useEffect(() => {
    if (connectionState === 'live' && lines.length === 0) void refreshLines();
  }, [connectionState, lines.length, refreshLines]);

  // 1.3.2 ①：会话头部 pending 指示（决策模态收起后仍可点开重答）。
  const firstDecision = decisions[0] ?? null;
  const pendingDecision = decisions.length > 0 && (activeDecisionId === null || !decisions.some((d) => d.decisionId === activeDecisionId));

  const activeLine = lines.find((r) => r.active);
  const tokensUsed = sessionTokensUsed(session.items);

  return (
    <div className="menubar">
      <div className="mb-left">
        <span className="mb-brand" title="zhishi">◣ zhishi</span>
        <span
          className="mb-line"
          title={`当前研究线（line/list active 行）${activeLine ? `——${activeLine.envKey}` : ''}`}
        >
          线 <span className={`ln-dot ${activeLine?.stateDot ?? 'cold'}`} />
          <span className="mb-line-id">{activeLine ? shortLineId(activeLine.id) : '—'}</span>
          {activeLine?.shared && <span className="mb-shared">共享</span>}
        </span>
        {/* 1.6.11：mission 徽章（无类型不显）+ 形态选择器（连上 sidecar 即可
            设——派任务前先定形态，不再等会话绑定） */}
        {mission?.kind && (
          <span className="seg mission-badge" title={`任务形态：${missionLabel(mission.kind)}（打法轴，挂会话线）`}>
            ⛳ {missionLabel(mission.kind)}
          </span>
        )}
        <select
          className="btn small mission-select"
          title="任务形态（打法轴，挂会话线不挂环境；挖掘=战役形态入口；改动随系统提示注入后续 turn）"
          value={mission?.kind ?? ''}
          disabled={connectionState !== 'live'}
          onChange={(e) => void setMission(missionPatchValue(e.target.value))}
        >
          {MISSION_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              形态：{o.label}
            </option>
          ))}
        </select>
      </div>
      {/* 原 Toolbar 按钮群（V4-S2/S4 才迁走——暂驻 menubar 右侧，功能一颗不丢） */}
      <div className="mb-actions">
        <button
          className="btn small"
          title="历史会话（清单 / 只读回看 / 载回续跑）"
          onClick={() => void openHistoryPanel()}
        >
          ▤ 历史
        </button>
        <button
          className="btn small"
          disabled={autoRunActive || !envKey}
          title={
            autoRunActive
              ? 'auto loop 运行中——先观察或 Esc 终止'
              : !envKey
                ? '先选择环境——一切操作都在环境内'
                : '启动 auto loop（目标式研究循环：侦察→分析→构造→执行→评估）'
          }
          onClick={openAutoRunStart}
        >
          ⚡ auto loop
        </button>
        {/* 决策②修订：档案唯一落位 SidePane「档案」页签——宽屏窄屏同一入口。 */}
        <button
          className="btn small"
          title="研究档案（过程记录 + 成果汇总——假设/证据/结论/未决问题，点行纠正）"
          onClick={() => openSidePane('archive')}
        >
          ▦ 研究{archiveBadge > 0 ? ` ${archiveBadge}` : ''}
        </button>
        {pendingDecision && firstDecision && (
          <button
            className="toolbar-decision pending"
            title={`${decisions.length} 个决策待答——点开重答`}
            onClick={() => openDecision(firstDecision.decisionId)}
          >
            ⚖ 决策待答 {decisions.length}
          </button>
        )}
        {connectionState === 'failed' && (
          <>
            <span className="conn-err" title={connectError ?? ''}>
              {connectError ?? '连接失败'}
            </span>
            <button className="btn small" onClick={init}>重试</button>
          </>
        )}
      </div>
      {/* 系统计量（设计稿 §2 menubar 右段） */}
      <div className="mb-meters">
        {session.contextPct !== undefined && (
          <span className="mb-meter" title="上下文占用（会话内 tokens / 模型窗口）">
            ctx <b>{session.contextPct}%</b>
          </span>
        )}
        <span className="mb-meter" title="本会话已完成 turn 的 token 累计（input + output）">
          tok <b>{formatTokens(tokensUsed)}</b>
        </span>
        {/* 决策①④：env 计量段 = 正门显式入口（无环境/新建场景的家）。
            环境详情 modal 仍走 StatusBar env 锚——两个入口各管一件事。 */}
        <span
          className="mb-meter mb-env clickable"
          title={`当前环境：${hostAnchorLabel(envKey)}——点击开正门（选/建环境；${connectionState === 'live' ? '就绪' : '等待 sidecar'}）`}
          onClick={() => setPage('gate')}
        >
          ◈ {hostAnchorLabel(envKey)}
        </span>
        <MenubarClock />
      </div>
    </div>
  );
}
