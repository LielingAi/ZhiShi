/**
 * 1.6.8 M2 — 战役（discovery campaign）本体：记录 + 状态机 + 文件存储。
 *
 * 设计稿：docs/design/discovery-campaign.md（v3）。战役 = 信号驱动的发现式
 * 搜索编排——盲跑基座（env_bg 长跑）持续运转，信号（平台期/新崩溃/基座退出）
 * 驱动介入回合（invoke 通道，headless），墙钟预算按天计。
 *
 * 本模块是状态与纯函数层（照 auto-run.ts 的形态纪律：状态机转移/平台期判定/
 * 预算是纯函数可单测；存储是薄 IO）。运行时（采样器/介入回合发射）在
 * campaign-runtime.ts；引擎触发点（mission=discover 的会话线起跑）在
 * chat-engine。
 *
 * 不双写纪律：假设/证据全走 research_archive（H#/V#），本记录只存状态机
 * 与信号史；产出走 research_events（task_kind=fuzz）。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { randomUUID } from 'node:crypto';

import { getZhiShiDataDir } from '../utils/app-dirs';
import { withFileLock, writeFileAtomic } from '../utils/file-lock';

// ---------------------------------------------------------------------------
// 记录与状态机
// ---------------------------------------------------------------------------

export type CampaignState =
  | 'running'    // 基座盲跑中
  | 'plateau'    // 平台期——破冰回路介入中
  | 'triaging'   // 新崩溃——分拣介入中
  | 'deepening'  // 深挖介入中（crash-triager 深挖模式）
  | 'paused'     // 预算耗尽/人停（可续命）
  | 'completed'  // 成功判据达成
  | 'stopped';   // 人终止

export const CAMPAIGN_STATES: readonly CampaignState[] = [
  'running', 'plateau', 'triaging', 'deepening', 'paused', 'completed', 'stopped',
];

/** 合法转移表（plateau/triaging/deepening 都是介入态，介入完回 running）。 */
const ALLOWED_TRANSITIONS: Readonly<Record<CampaignState, readonly CampaignState[]>> = {
  running: ['plateau', 'triaging', 'deepening', 'paused', 'completed', 'stopped'],
  plateau: ['running', 'triaging', 'paused', 'completed', 'stopped'],
  triaging: ['running', 'deepening', 'paused', 'completed', 'stopped'],
  deepening: ['running', 'paused', 'completed', 'stopped'],
  paused: ['running', 'stopped'],
  completed: [],
  stopped: [],
};

export interface CampaignSignalEntry {
  ts: string;
  kind: 'fuzz:plateau' | 'fuzz:new-crash' | 'bg:finished' | 'budget' | 'manual' | 'intervention';
  detail: string;
}

/** fuzzer_stats 的采样快照（平台期/崩溃判定的输入）。 */
export interface CampaignStatsSample {
  paths: number;
  crashes: number;
  execsPerSec: number;
  at: number; // epoch ms
}

export interface CampaignRecord {
  id: string;
  workspace: string;
  /** 战役所在环境 id。 */
  envId: string;
  /** 会话线（介入回合 invoke 到这条线；mission=discover 的载体）。 */
  loopSessionId: string;
  /** 靶（首条任务文本）。 */
  goal: string;
  /** 成功判据（起跑时钉死；缺省见 DEFAULT_CRITERIA）。 */
  criteria: string[];
  state: CampaignState;
  createdAt: string;
  updatedAt: string;
  /** 起跑时刻（state 首次进 running）。 */
  startedAt: string;
  /** 墙钟预算（ms；缺省 1 天）。 */
  wallBudgetMs: number;
  /** 已耗墙钟（ms；paused 时间不计）。 */
  spentWallMs: number;
  /** 进入当前 running 段的起点（spentWallMs 累计的锚）。 */
  runningSince?: string;
  /** 基座 env_bg tag（bg:finished 信号按它对账）。 */
  baseTag?: string;
  /** 采样目标：afl -o 输出目录（fuzzer_stats + crashes/ 的父目录）。 */
  corpusOut?: string;
  lastStats?: CampaignStatsSample;
  /** 连续无新路径采样次数（平台期判据计数）。 */
  plateauStreak: number;
  /** 已见崩溃文件数（新崩溃信号的游标）。 */
  crashCursor: number;
  /** 去重后的崩溃类指纹清单（stack-hash）。 */
  crashClasses: string[];
  signalLog: CampaignSignalEntry[];
  outcome?: string;
}

export const DEFAULT_WALL_BUDGET_MS = 24 * 60 * 60_000; // 1 天
export const DEFAULT_CAMPAIGN_CRITERIA = ['至少 1 类去重崩溃，且 crash-triager 出了归类结论'];
/** 平台期判据：连续 N 次采样无新路径（且 execs 在跑）。 */
export const PLATEAU_STREAK_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// 纯函数 — 转移校验 / 平台期判定 / 墙钟预算 / 信号史
// ---------------------------------------------------------------------------

export function canTransition(from: CampaignState, to: CampaignState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function transitionCampaign(
  record: CampaignRecord,
  to: CampaignState,
  opts: { ts?: string; signal?: CampaignSignalEntry } = {},
): CampaignRecord {
  if (!canTransition(record.state, to)) {
    throw new Error(`campaign ${record.id}: 非法状态转移 ${record.state} → ${to}`);
  }
  const ts = opts.ts ?? new Date().toISOString();
  // 墙钟记账：离开 running 段时结算；进入 running 段时开锚。
  let { spentWallMs, runningSince } = record;
  if (record.state === 'running' && runningSince) {
    spentWallMs += new Date(ts).getTime() - new Date(runningSince).getTime();
    runningSince = undefined;
  }
  if (to === 'running') runningSince = ts;
  const signalLog = opts.signal ? appendCampaignSignal(record.signalLog, opts.signal) : record.signalLog;
  return { ...record, state: to, updatedAt: ts, spentWallMs, runningSince, signalLog };
}

/** 墙钟消耗（含进行中的 running 段）。 */
export function campaignWallSpent(record: CampaignRecord, now: number = Date.now()): number {
  let spent = record.spentWallMs;
  if (record.state === 'running' && record.runningSince) {
    spent += now - new Date(record.runningSince).getTime();
  }
  return spent;
}

export function isCampaignWallExhausted(record: CampaignRecord, now: number = Date.now()): boolean {
  return campaignWallSpent(record, now) >= record.wallBudgetMs;
}

/**
 * 平台期判定：本次采样与上次比较——有新路径（paths 涨）→ streak 清零；
 * 无新路径且 execs 在跑（>0）→ streak+1；execs 归零（基座死了）也计
 * （基座退出另有 bg:finished 信号，采样侧只认「无进展」）。streak 达阈值
 * 即平台期。返回新 streak 与是否触发。
 */
export function judgePlateau(
  record: CampaignRecord,
  sample: CampaignStatsSample,
): { streak: number; plateau: boolean } {
  const prev = record.lastStats;
  const progressed = prev !== undefined && sample.paths > prev.paths;
  const streak = progressed ? 0 : record.plateauStreak + 1;
  return { streak, plateau: streak >= PLATEAU_STREAK_THRESHOLD };
}

/** 新崩溃判定：崩溃目录文件数 > 游标 → 新增量。 */
export function judgeNewCrashes(record: CampaignRecord, crashCount: number): number {
  return Math.max(0, crashCount - record.crashCursor);
}

/** 信号史追加上限（防无限增长——长跑战役信号以百计）。 */
export const CAMPAIGN_SIGNAL_LOG_MAX = 200;

export function appendCampaignSignal(
  log: CampaignSignalEntry[],
  entry: CampaignSignalEntry,
): CampaignSignalEntry[] {
  const next = [...log, entry];
  return next.length > CAMPAIGN_SIGNAL_LOG_MAX ? next.slice(next.length - CAMPAIGN_SIGNAL_LOG_MAX) : next;
}

// ---------------------------------------------------------------------------
// 存储（薄 IO——照 auto-run 的 per-file json + file-lock 纪律）
// ---------------------------------------------------------------------------

export function defaultCampaignsDir(dir?: string): string {
  return join(dir ?? getZhiShiDataDir(), 'campaigns');
}

export function campaignFilePath(id: string, dir: string): string {
  return join(dir, `${id}.json`);
}

export function serializeCampaignRecord(record: CampaignRecord): string {
  return JSON.stringify(record, null, 2) + '\n';
}

export function parseCampaignRecord(content: string): CampaignRecord | null {
  try {
    const raw = JSON.parse(content) as CampaignRecord;
    if (!raw || typeof raw.id !== 'string' || !CAMPAIGN_STATES.includes(raw.state)) return null;
    return raw;
  } catch {
    return null;
  }
}

export interface CampaignStoreOptions {
  dir?: string;
}

/**
 * 落盘：withFileLock（.lock 目录锁——lockPath 是锁目录不是目标文件）+
 * tmp+rename 原子整写（对齐 auto-run/loop-sessions 纪律）。写失败仅告警——
 * 记录不是真相，丢写不拖死战役。
 */
export async function saveCampaignRecord(record: CampaignRecord, options: CampaignStoreOptions = {}): Promise<void> {
  const dir = defaultCampaignsDir(options.dir);
  try {
    mkdirSync(dir, { recursive: true });
    const file = campaignFilePath(record.id, dir);
    await withFileLock({ lockPath: `${file}.lock` }, async () => {
      writeFileAtomic(file, serializeCampaignRecord(record));
    });
  } catch (err) {
    console.warn(`[campaign] 记录落盘失败（内存态继续，重启后本记录不可恢复）：${err instanceof Error ? err.message : String(err)}`);
  }
}

export function loadCampaignRecord(id: string, options: CampaignStoreOptions = {}): CampaignRecord | null {
  const file = campaignFilePath(id, defaultCampaignsDir(options.dir));
  if (!existsSync(file)) return null;
  try {
    return parseCampaignRecord(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

export function listCampaignRecords(options: CampaignStoreOptions = {}): CampaignRecord[] {
  const dir = defaultCampaignsDir(options.dir);
  if (!existsSync(dir)) return [];
  const out: CampaignRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const rec = parseCampaignRecord(readFileSync(join(dir, name), 'utf-8'));
      if (rec) out.push(rec);
    } catch {
      continue; // 单文件损坏不炸整表
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// ---------------------------------------------------------------------------
// 创建
// ---------------------------------------------------------------------------

export function createCampaignRecord(input: {
  workspace: string;
  envId: string;
  loopSessionId: string;
  goal: string;
  criteria?: string[];
  wallBudgetMs?: number;
  now?: string;
}): CampaignRecord {
  const now = input.now ?? new Date().toISOString();
  return {
    id: randomUUID(),
    workspace: input.workspace,
    envId: input.envId,
    loopSessionId: input.loopSessionId,
    goal: input.goal,
    criteria: input.criteria?.length ? input.criteria : [...DEFAULT_CAMPAIGN_CRITERIA],
    state: 'running',
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    wallBudgetMs: input.wallBudgetMs ?? DEFAULT_WALL_BUDGET_MS,
    spentWallMs: 0,
    runningSince: now,
    plateauStreak: 0,
    crashCursor: 0,
    crashClasses: [],
    signalLog: [],
  };
}
