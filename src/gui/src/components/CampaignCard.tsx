/**
 * 战役对象卡（第三批 v4 落地）：/tasks 选中战役行的详情视图——头部
 * ⚔ goal + 状态徽章、FSM 四段轨道、墙钟预算条（1s tick 重算 running 段）、
 * 采样摘要行、崩溃类 chips、信号 feed（倒序 + outcome 置顶 banner）、
 * 终止/续命动作行（与行内按钮同参数，复用 store 动作；终态无按钮）。
 *
 * 纯展示组件：数据面全部来自 model/campaign-card.ts 纯函数，本文件不
 * 含装配逻辑。墙钟 running 段随时间推进——本地 now state 每秒 tick
 * 重算（dispose 清理），不戳 store（campaign/list 轮询照旧，互不干扰）。
 */

import { useEffect, useState } from 'react';
import type React from 'react';

import { useGuiStore } from '../store/useGuiStore';
import {
  CAMPAIGN_STATE_LABELS,
  campaignActionOf,
  campaignWallText,
  type CampaignRecordLike,
  type CampaignState,
} from '../model/campaign';
import { crashChipsOf, fsmTrackOf, signalFeedOf, statsLineOf, wallBudgetOf } from '../model/campaign-card';

/** 状态徽章色调：running 绿 / 介入三态琥珀 / paused 红 / 终态 dim。 */
function badgeClassOf(state: CampaignState): string {
  if (state === 'running') return 'cc-badge run';
  if (state === 'paused') return 'cc-badge halt';
  if (state === 'completed' || state === 'stopped') return 'cc-badge done';
  return 'cc-badge mid';
}

export function CampaignCard({ record }: { record: CampaignRecordLike }): React.JSX.Element {
  // 1s tick：running 段墙钟按 now 续算（campaignSpentMs 同口径），dispose 清理。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const requestCampaignStop = useGuiStore((s) => s.requestCampaignStop);
  const resumeCampaign = useGuiStore((s) => s.resumeCampaign);
  // 第四批 v4：崩溃类 chip → 崩溃件检查器（按指纹过滤 fuzz 分拣结论）。
  const openCrashInspector = useGuiStore((s) => s.openCrashInspector);

  const track = fsmTrackOf(record.state);
  const wall = wallBudgetOf(record, now);
  const statsLine = statsLineOf(record);
  const chips = crashChipsOf(record);
  const feed = signalFeedOf(record);
  const action = campaignActionOf(record.state);

  return (
    <div className="cc-card">
      {/* 头部：⚔ goal（全量不截断——行内截断 40 是清单密度需要）+ 状态徽章。 */}
      <div className="cc-head">
        <span className="cc-goal">⚔ {record.goal}</span>
        <span className={badgeClassOf(record.state)}>{CAMPAIGN_STATE_LABELS[record.state]}</span>
      </div>

      {/* FSM 轨道：活跃态四段横排（只标当前 on，循环态不推断历史）；
          paused 全 todo + 挂起标；终态用收尾行替代轨道。 */}
      {track.terminal ? (
        <div className="cc-terminal">终态收尾 · {CAMPAIGN_STATE_LABELS[record.state]}</div>
      ) : (
        <div className="fsm">
          {track.items.map((it) => (
            <span key={it.key} className={it.phase}>
              {it.label}
            </span>
          ))}
          {track.halted && <span className="fsm-halt">挂起待人</span>}
        </div>
      )}

      {/* 墙钟预算：pct=null（预算缺省）只显文字不画条；≥90% 条转琥珀提示余量告急。 */}
      <div className="cc-wall">
        <div className="cc-wall-label">
          <span>{campaignWallText(record, now)}</span>
          {wall.pct !== null && <span>{wall.pct}%</span>}
        </div>
        {wall.pct !== null && (
          <div className="cc-bar">
            <i className={wall.pct >= 90 ? 'hot' : ''} style={{ width: `${wall.pct}%` }} />
          </div>
        )}
      </div>

      {/* 采样摘要 + 崩溃类 chips（缺省则不渲染该行；chip 点击进崩溃件检查器）。 */}
      {statsLine && <div className="cc-stats">{statsLine}</div>}
      {chips.length > 0 && (
        <div className="cc-chips">
          {chips.map((c) => (
            <span
              className="cc-chip"
              key={c}
              title="崩溃件检查器——按该指纹过滤 fuzz 分拣结论"
              onClick={() => openCrashInspector(c)}
            >
              {c}
            </span>
          ))}
        </div>
      )}

      {/* 信号 feed：outcome 置顶 banner + 倒序可滚动列表（最新在前）。 */}
      {feed.banner && <div className="cc-banner">{feed.banner}</div>}
      <div className="cc-feed">
        {feed.items.length === 0 && <div className="ov-empty">暂无信号</div>}
        {feed.items.map((s, i) => (
          <div className="cc-sig" key={`${s.ts ?? ''}-${i}`}>
            <span className="t">{s.ts ?? ''}</span>
            <span className="k">{s.kind ?? 'signal'}</span>
            <span className="d">{s.detail ?? ''}</span>
          </div>
        ))}
      </div>

      {/* 动作行：与行内按钮同参数（stop 带二次确认模态；终态无按钮）。 */}
      {action && (
        <div className="cc-actions">
          {action === 'resume' && (
            <button
              className="btn small"
              title="campaign/resume——预算耗尽暂停续命（重置墙钟起算）"
              onClick={() => void resumeCampaign(record.id)}
            >
              续命
            </button>
          )}
          {action === 'stop' && (
            <button
              className="btn small danger"
              title="campaign/stop——人终止战役（二次确认）"
              onClick={() => requestCampaignStop({ id: record.id, goal: record.goal })}
            >
              终止
            </button>
          )}
        </div>
      )}
    </div>
  );
}
