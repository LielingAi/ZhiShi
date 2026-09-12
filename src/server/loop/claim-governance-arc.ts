/**
 * 1.7.2 — 会话 Claim 治理扫描（design: 1.7.2-compaction.md §7.2 调度）。
 *
 * 治理是引擎内务：sidecar 启动后以受护定时器（guarded timer）周期性扫描
 * 活跃会话线，逐线跑 runClaimGovernance（幂等游标,失败不推进）。与 Rust
 * TaskScheduler 解耦——治理不需要 UI 可见性/人工编辑,蒸馏弧那种用户可
 * 感知的任务形态不适用;定时器随 sidecar 生命周期重启即恢复,游标幂等。
 *
 * 并发安全：多 sidecar 并发治理同一会话时,claims 文件锁 + 游标 max() +
 * 内容去重保证幂等（重复治理只产生 deduped 计数,不产生重复条目）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getZhiShiDataDir } from '../utils/app-dirs';
import type { SessionMetadata } from '../types/session';
import {
  buildProductionExtractor,
  GOVERNANCE_INTERVAL_MINUTES,
  runClaimGovernance,
  type GovernanceResult,
} from './claim-governance';

/** 扫描窗口:lastActiveAt 在 N 天内的会话才算活跃（蒸馏弧同口径 7 天,治理取 7）。 */
const GOVERNANCE_ACTIVE_DAYS = 7;
/** 单会话治理的最小间隔守卫（防多 sidecar/短间隔重复扫同一线,游标幂等兜底）。 */
const GOVERNANCE_SWEEP_MIN_MS = 60_000;

function loadSessions(): SessionMetadata[] {
  const sessionsPath = join(getZhiShiDataDir(), 'sessions.json');
  if (!existsSync(sessionsPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(sessionsPath, 'utf-8')) as SessionMetadata[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn('[governance] sessions.json 解析失败,按无会话处理:', err instanceof Error ? err.message : String(err));
    return [];
  }
}

/** 活跃会话线（有 loopSessionId 且近期活跃）。 */
export function listGovernableSessions(now: number): Array<{ sessionId: string; workspace: string }> {
  const cutoff = now - GOVERNANCE_ACTIVE_DAYS * 24 * 3600_000;
  const out: Array<{ sessionId: string; workspace: string }> = [];
  for (const s of loadSessions()) {
    if (!s.loopSessionId) continue;
    const last = Date.parse(s.lastActiveAt);
    if (Number.isFinite(last) && last < cutoff) continue;
    out.push({ sessionId: s.loopSessionId, workspace: s.agentDir });
  }
  return out;
}

export interface GovernanceSweepResult {
  sessions: number;
  okCount: number;
  failCount: number;
  results: GovernanceResult[];
}

/** 一轮扫描:逐线治理（串行,单线失败不阻断其他线）。 */
export async function runGovernanceSweep(now: number = Date.now()): Promise<GovernanceSweepResult> {
  const targets = listGovernableSessions(now);
  const results: GovernanceResult[] = [];
  let okCount = 0;
  let failCount = 0;
  for (const t of targets) {
    try {
      const r = await runClaimGovernance(t.sessionId, {
        extract: buildProductionExtractor(),
        workspace: t.workspace,
      });
      results.push(r);
      if (r.ok) okCount++;
      else failCount++;
    } catch (err) {
      failCount++;
      console.warn(`[governance] 会话 ${t.sessionId} 治理异常(不阻断扫描):${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (targets.length > 0) {
    console.log(`[governance] sweep: ${targets.length} sessions, ok=${okCount} fail=${failCount}`);
  }
  return { sessions: targets.length, okCount, failCount, results };
}

/** 受护定时器:上一个 sweep 未结束/间隔过短不重入（guarded timer 纪律）。 */
export function startGovernanceTimer(): NodeJS.Timeout {
  let running = false;
  let lastSweepAt = 0;
  const timer = setInterval(() => {
    if (running) return;
    const now = Date.now();
    if (now - lastSweepAt < GOVERNANCE_SWEEP_MIN_MS) return;
    running = true;
    lastSweepAt = now;
    void runGovernanceSweep(now)
      .catch((err) => console.warn('[governance] sweep 异常:', err instanceof Error ? err.message : String(err)))
      .finally(() => { running = false; });
  }, GOVERNANCE_INTERVAL_MINUTES * 60_000);
  // 启动后先跑一轮（错峰:延迟 2 分钟,避开启动高峰）。
  setTimeout(() => {
    if (running) return;
    running = true;
    lastSweepAt = Date.now();
    void runGovernanceSweep()
      .catch((err) => console.warn('[governance] 启动 sweep 异常:', err instanceof Error ? err.message : String(err)))
      .finally(() => { running = false; });
  }, 2 * 60_000);
  return timer;
}
