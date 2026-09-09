/**
 * 1.6.8 M2 — 战役运行时：采样器 + 介入回合发射 + 注册表。
 *
 * 设计稿：docs/design/discovery-campaign.md（v3）§3 状态机 / §4 信号源 /
 * §5 预算。本模块是薄 IO 编排层——状态转移/平台期判定/预算全在
 * campaign.ts 的纯函数里，这里只做「定时采样 → 判信号 → 转移 → 发射介入
 * 回合（invoke 通道 headless）」。
 *
 * 信号覆盖说明：bg:finished 在战役侧不单独订阅——基座退出会立刻表现为
 * execs 归零/统计停滞，采样器一个通道全覆盖（交互线的 bg 回注是 1.6.7 R2
 * 的既有面，战役不重复订阅）。
 *
 * 采样读取（1.6.8 v1）：docker 环境 = 宿主 bind mount 直接读
 * <workspace>/fuzz/corpus-out（配方约定目录）；linux vm/ssh = 环境通道
 * cat/ls；windows vm 暂无采样通道（介入回合内 agent 自行 cat——v1 边界，
 * 记录在案）。
 *
 * 结构纪律照 auto-run：依赖全注入（deps），单测不碰真通道/真模型。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { EnvironmentEntry } from '../../shared/config-types';
import {
  campaignWallSpent,
  canTransition,
  createCampaignRecord,
  isCampaignWallExhausted,
  judgeNewCrashes,
  judgePlateau,
  loadCampaignRecord,
  saveCampaignRecord,
  transitionCampaign,
  type CampaignRecord,
  type CampaignStatsSample,
} from './campaign';

// ---------------------------------------------------------------------------
// 依赖注入面
// ---------------------------------------------------------------------------

export interface CampaignRuntimeDeps {
  /** 按 id 找环境条目（生产 = registry 读 config）。 */
  findEnv: (envId: string) => EnvironmentEntry | null;
  /** 环境通道一次性命令（生产 = env-exec 统一分派；仅 vm/ssh 采样用）。 */
  envExec: (entry: EnvironmentEntry, command: string, timeoutMs: number) => Promise<{ ok: boolean; stdout?: string }>;
  /**
   * 介入回合发射（生产 = invokePiSession 的薄包装——headless 介入会话线）。
   * 返回的 error 非空 = 回合没跑起来（模型不可用等）。
   */
  invokeRound: (input: { text: string; loopSessionId: string }) => Promise<{ error?: string }>;
  /** 采样间隔（默认 5 分钟；测试给毫秒级）。 */
  pollMs?: number;
  /** 墙钟源（测试可固定）。 */
  now?: () => number;
  /** 存储目录（生产缺省 ~/.zhishi/campaigns；测试传临时目录——绝不写真盘）。 */
  storeDir?: string;
}

export const CAMPAIGN_POLL_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// 采样读取（生产实现；测试注入假读）
// ---------------------------------------------------------------------------

/** fuzzer_stats 文本 → 采样快照字段（afl 的 key: value 格式）。 */
export function parseFuzzerStats(content: string, at: number): CampaignStatsSample | null {
  const get = (key: string): number | undefined => {
    const m = new RegExp(`^${key}\\s*:\\s*(\\d+)`, 'm').exec(content);
    return m ? Number(m[1]) : undefined;
  };
  const paths = get('saved_items') ?? get('cur_item');
  const crashes = get('saved_crashes');
  const execsPerSec = get('execs_per_sec');
  if (paths === undefined || crashes === undefined || execsPerSec === undefined) return null;
  return { paths, crashes, execsPerSec, at };
}

/** 采样读取（docker 宿主直读 / vm·ssh 走环境通道）。 */
export async function readCampaignSample(
  record: CampaignRecord,
  deps: Pick<CampaignRuntimeDeps, 'findEnv' | 'envExec'>,
  now: () => number = () => Date.now(),
): Promise<{ stats: CampaignStatsSample | null; crashCount: number | null }> {
  const entry = deps.findEnv(record.envId);
  if (!entry) return { stats: null, crashCount: null };
  const corpusOut = record.corpusOut ?? join('fuzz', 'corpus-out');
  const at = now();

  if (entry.kind === 'docker') {
    // 宿主 bind mount 直读（/workspace = workspace）
    const dir = join(record.workspace, corpusOut, 'default');
    const statsPath = join(dir, 'fuzzer_stats');
    const crashesDir = join(dir, 'crashes');
    const stats = existsSync(statsPath)
      ? parseFuzzerStats(readFileSync(statsPath, 'utf-8'), at)
      : null;
    const crashCount = existsSync(crashesDir)
      ? readdirSync(crashesDir).filter((f) => f.startsWith('id:')).length
      : null;
    return { stats, crashCount };
  }

  // vm/ssh（linux）：环境通道 cat + ls 计数
  const statsCmd = `cat "${corpusOut}/default/fuzzer_stats" 2>/dev/null`;
  const r1 = await deps.envExec(entry, statsCmd, 15_000);
  const stats = r1.ok && r1.stdout ? parseFuzzerStats(r1.stdout, at) : null;
  const r2 = await deps.envExec(entry, `ls "${corpusOut}/default/crashes" 2>/dev/null | grep -c '^id:'`, 15_000);
  const crashCount = r2.ok && r2.stdout !== undefined ? Number.parseInt(r2.stdout.trim(), 10) : null;
  return { stats, crashCount: Number.isInteger(crashCount) ? crashCount : null };
}

// ---------------------------------------------------------------------------
// 介入回合文本（纯函数——注入信号上下文 + 战役快照）
// ---------------------------------------------------------------------------

export function buildPlateauInterventionText(record: CampaignRecord): string {
  const s = record.lastStats;
  return (
    `[战役介入 · 平台期] 盲跑基座连续 ${record.plateauStreak} 次采样无新路径` +
    `（paths=${s?.paths ?? '?'}，execs/s=${s?.execsPerSec ?? '?'}，崩溃=${s?.crashes ?? 0}）。\n` +
    `按 <zhishi-mission> 的破冰回路执行：读目标源码 → 假设落档案（H#）→ 定向构造输入/变体 → ` +
    `回灌 fuzz/corpus-in 或调整 harness。基座 tag=${record.baseTag ?? '?'} 若已死（execs 归零），先重启盲跑再破冰。\n` +
    `战役目标：${record.goal}\n成功判据：${record.criteria.join('；')}\n` +
    '本轮介入结论用 declare_completion 报（继续盲跑/建议收口/建议人介入）。'
  );
}

export function buildCrashInterventionText(record: CampaignRecord, newCount: number): string {
  return (
    `[战役介入 · 新崩溃] 崩溃目录新增 ${newCount} 个样本（游标 ${record.crashCursor} → ${record.crashCursor + newCount}）。\n` +
    '委派 crash-triager 批处理分拣（delegate_task，agent=crash-triager）：去重归类 → 变体回灌 fuzz/corpus-in。' +
    '有源码时可对单个崩溃类深挖（其深挖模式）。\n' +
    `战役目标：${record.goal}\n成功判据：${record.criteria.join('；')}`
  );
}

export function buildBudgetPausedText(record: CampaignRecord): string {
  return (
    `[战役暂停 · 墙钟预算耗尽] 已耗 ${Math.round(campaignWallSpent(record) / 60_000)} 分钟 / ` +
    `预算 ${Math.round(record.wallBudgetMs / 60_000)} 分钟。人可在任务中心续命或终止。`
  );
}

// ---------------------------------------------------------------------------
// 控制器注册表（每会话线最多一个活跃战役——单实例闸同 auto loop）
// ---------------------------------------------------------------------------

interface CampaignController {
  record: CampaignRecord;
  timer: ReturnType<typeof setInterval>;
  /** 介入回合在飞闸（同战役同时最多一个介入回合）。 */
  intervening: boolean;
}

const activeCampaigns = new Map<string, CampaignController>(); // key = loopSessionId

/** 测试钩子：清注册表（timer 全停）。 */
export function resetCampaignRegistryForTest(): void {
  for (const c of activeCampaigns.values()) clearInterval(c.timer);
  activeCampaigns.clear();
}

export function activeCampaignForLine(loopSessionId: string): CampaignRecord | undefined {
  return activeCampaigns.get(loopSessionId)?.record;
}

/**
 * 引擎触发点（mission=discover 唯一入口的落地）：会话线有活跃战役 → 幂等
 * 返回 null；否则起跑。chat-engine 在 turn 起跑时调用（mission 从绑定 meta
 * 读，调用方负责判定 discover）。
 */
export async function maybeStartCampaign(
  input: {
    workspace: string;
    envId: string;
    loopSessionId: string;
    goal: string;
    criteria?: string[];
    wallBudgetMs?: number;
  },
  deps: CampaignRuntimeDeps,
): Promise<CampaignRecord | null> {
  if (activeCampaignForLine(input.loopSessionId)) return null; // 幂等（单实例闸）
  return startCampaign(input, deps);
}

/** 战役起跑（登记 + 采样器 + 落盘）。调用方保证同线无活跃战役。 */
export async function startCampaign(
  input: {
    workspace: string;
    envId: string;
    loopSessionId: string;
    goal: string;
    criteria?: string[];
    wallBudgetMs?: number;
  },
  deps: CampaignRuntimeDeps,
): Promise<CampaignRecord> {
  if (activeCampaigns.has(input.loopSessionId)) {
    throw new Error(`会话线 ${input.loopSessionId} 已有活跃战役（单实例闸）`);
  }
  const record = createCampaignRecord(input);
  const controller = { record, intervening: false } as CampaignController;
  const pollMs = deps.pollMs ?? CAMPAIGN_POLL_MS;
  controller.timer = setInterval(() => { void tickCampaign(controller, deps); }, pollMs);
  activeCampaigns.set(input.loopSessionId, controller);
  await saveCampaignRecord(controller.record, { dir: deps.storeDir });
  return controller.record;
}

/** 人终止。 */
export async function stopCampaign(id: string, options: { dir?: string } = {}): Promise<{ ok: boolean; error?: string }> {
  const entry = [...activeCampaigns.entries()].find(([, c]) => c.record.id === id);
  if (!entry) {
    // 非活跃（历史记录）也允许标 stopped——读盘转移
    const rec = loadCampaignRecord(id, { dir: options.dir });
    if (!rec) return { ok: false, error: `未找到战役 ${id}` };
    if (!canTransition(rec.state, 'stopped')) return { ok: false, error: `战役 ${id} 已是终态（${rec.state}）` };
    const next = transitionCampaign(rec, 'stopped', {
      signal: { ts: new Date().toISOString(), kind: 'manual', detail: '人终止' },
    });
    await saveCampaignRecord(next, { dir: options.dir });
    return { ok: true };
  }
  const [, controller] = entry;
  clearInterval(controller.timer);
  const next = transitionCampaign(controller.record, 'stopped', {
    signal: { ts: new Date().toISOString(), kind: 'manual', detail: '人终止' },
  });
  controller.record = next;
  await saveCampaignRecord(next, { dir: options.dir });
  activeCampaigns.delete(entry[0]);
  return { ok: true };
}

/** 暂停续命（paused → running；墙钟锚重置由 transitionCampaign 结算）。 */
export async function resumeCampaign(id: string, options: { dir?: string } = {}): Promise<{ ok: boolean; error?: string }> {
  const entry = [...activeCampaigns.entries()].find(([, c]) => c.record.id === id);
  if (!entry) return { ok: false, error: `战役 ${id} 不在活跃注册表（sidecar 重启后的历史战役恢复暂不支持）` };
  const [, controller] = entry;
  if (controller.record.state !== 'paused') return { ok: false, error: `战役 ${id} 不在暂停态（${controller.record.state}）` };
  const next = transitionCampaign(controller.record, 'running', {
    signal: { ts: new Date().toISOString(), kind: 'manual', detail: '人续命' },
  });
  controller.record = next;
  await saveCampaignRecord(next, { dir: options.dir });
  return { ok: true };
}

/** 采样 tick（注册表驱动的唯一信号源）。 */
async function tickCampaign(controller: CampaignController, deps: CampaignRuntimeDeps): Promise<void> {
  const now = deps.now?.() ?? Date.now();
  const nowFn = deps.now ?? (() => Date.now());
  const record = controller.record;
  if (record.state !== 'running') return;

  // 墙钟预算：耗尽 → paused（人可续命，auto loop 同语义）。
  if (isCampaignWallExhausted(record, now)) {
    const next = transitionCampaign(record, 'paused', {
      ts: new Date(now).toISOString(),
      signal: { ts: new Date(now).toISOString(), kind: 'budget', detail: '墙钟预算耗尽' },
    });
    controller.record = next;
    await saveCampaignRecord(next, { dir: deps.storeDir });
    await deps.invokeRound({ text: buildBudgetPausedText(next), loopSessionId: record.loopSessionId });
    return;
  }

  const { stats, crashCount } = await readCampaignSample(record, deps, nowFn);
  if (crashCount === null && stats === null) return; // 采样通道失败 → 跳过本轮（不误判）

  // 新崩溃优先（分拣介入）。
  if (crashCount !== null) {
    const fresh = judgeNewCrashes(record, crashCount);
    if (fresh > 0 && !controller.intervening && canTransition(record.state, 'triaging')) {
      await fireIntervention(controller, deps, 'triaging', {
        ts: new Date(now).toISOString(), kind: 'fuzz:new-crash', detail: `新增 ${fresh} 个崩溃样本`,
      }, buildCrashInterventionText(record, fresh));
      return;
    }
  }

  // 平台期判定。
  if (stats) {
    const { streak, plateau } = judgePlateau(record, stats);
    const updated = { ...record, lastStats: stats, plateauStreak: streak, updatedAt: new Date(now).toISOString() };
    controller.record = updated;
    await saveCampaignRecord(updated, { dir: deps.storeDir });
    if (plateau && !controller.intervening && canTransition(updated.state, 'plateau')) {
      await fireIntervention(controller, deps, 'plateau', {
        ts: new Date(now).toISOString(), kind: 'fuzz:plateau', detail: `连续 ${streak} 次采样无新路径`,
      }, buildPlateauInterventionText(updated));
    }
  }
}

/** 介入回合发射：转移 → invoke → 回合结束回 running（介入态 = 转移本身）。 */
async function fireIntervention(
  controller: CampaignController,
  deps: CampaignRuntimeDeps,
  intoState: 'plateau' | 'triaging',
  signal: { ts: string; kind: CampaignRecord['signalLog'][number]['kind']; detail: string },
  text: string,
): Promise<void> {
  controller.intervening = true;
  try {
    const entered = transitionCampaign(controller.record, intoState, { ts: signal.ts, signal });
    controller.record = entered;
    await saveCampaignRecord(entered, { dir: deps.storeDir });
    const r = await deps.invokeRound({ text, loopSessionId: controller.record.loopSessionId });
    if (r.error) {
      console.warn(`[campaign] 介入回合失败（${controller.record.id}）：${r.error}`);
    }
    // 回合结束回 running（崩溃游标推进在 triaging 入口已记信号；分拣产出由
    // agent 经 research_log 落库——战役不接管内容账本）。
    const back = transitionCampaign(controller.record, 'running', {
      signal: { ts: new Date().toISOString(), kind: 'intervention', detail: `${intoState} 介入回合结束${r.error ? '（失败：' + r.error + '）' : ''}` },
    });
    controller.record = back;
    await saveCampaignRecord(back, { dir: deps.storeDir });
  } finally {
    controller.intervening = false;
  }
}
