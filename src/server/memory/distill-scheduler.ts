/**
 * 蒸馏调度器（2.0.7）——sidecar 侧的受护定时器，让蒸馏不再依赖 GUI 常驻。
 *
 * 背景（2026-10-22 复查）：蒸馏弧此前只挂在 Rust 调度器的 cron 上
 * （`/cron/execute-sync` 的哨兵分支）。CLI 起的 sidecar 没有 Rust 调度器，
 * 于是"用 CLI 干活"的机器上蒸馏一次都不会跑——`memory.db` 停在 2026-09-28
 * 就是这么来的。
 *
 * 本模块在 sidecar 进程内维护节律：每小时检查一次，到点就跑认知弧（1h）
 * 与安全弧（6h）。与 cron 触发**共用一个文件锁**，不会并发跑两份。
 *
 * 纪律：
 * - 受护定时器（guarded）：上一轮未结束不重入；
 * - 锁：`<数据目录>/memory/distilled/.arc.lock`（与 cron 路径同一把）；
 * - 落点状态：`<数据目录>/memory/distilled/.arc-state.json`（上次运行时间，
 *   跨重启保持节律，重启不会立刻补跑）；
 * - best-effort：任何异常只 warn，绝不拖垮 sidecar；
 * - unref：不阻止进程退出。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { withFileLock } from 'zhishi-loop-core/file-lock';

import { getZhiShiDataDir } from '../../shared/app-dirs';
import { ensureDirSync } from '../utils/fs-utils';

/** 检查节律：每小时看一次。 */
export const DISTILL_TIMER_INTERVAL_MS = 60 * 60_000;
/** 启动后延迟首轮（错峰，避开启动高峰）。 */
export const DISTILL_TIMER_FIRST_DELAY_MS = 5 * 60_000;
/** 认知弧最小间隔（与 DISTILL_INTERVAL_MINUTES 对齐）。 */
export const COGNITIVE_ARC_MIN_INTERVAL_MS = 60 * 60_000;
/** 安全弧最小间隔（与 RESEARCH_DISTILL_INTERVAL_MINUTES 对齐）。 */
export const RESEARCH_ARC_MIN_INTERVAL_MS = 6 * 60 * 60_000;

export interface ArcState {
  lastCognitiveAt?: number;
  lastResearchAt?: number;
}

function stateDir(): string {
  return join(getZhiShiDataDir(), 'memory', 'distilled');
}

export function arcStatePath(): string {
  return join(stateDir(), '.arc-state.json');
}

export function arcLockPath(): string {
  return join(stateDir(), '.arc.lock');
}

/** 读上次运行时间（坏文件按空处理）。 */
export function readArcState(): ArcState {
  try {
    const raw = readFileSync(arcStatePath(), 'utf-8');
    const parsed = JSON.parse(raw) as ArcState;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/** 写上次运行时间（best-effort）。 */
export function writeArcState(state: ArcState): void {
  try {
    ensureDirSync(stateDir());
    writeFileSync(arcStatePath(), JSON.stringify(state), 'utf-8');
  } catch (err) {
    console.warn('[distill-timer] state 写入失败:', err instanceof Error ? err.message : String(err));
  }
}

/** 纯函数：按节律判断该跑哪条弧。 */
export function dueArcs(state: ArcState, now: number, opts?: {
  cognitiveMs?: number;
  researchMs?: number;
}): { cognitive: boolean; research: boolean } {
  const cognitiveMs = opts?.cognitiveMs ?? COGNITIVE_ARC_MIN_INTERVAL_MS;
  const researchMs = opts?.researchMs ?? RESEARCH_ARC_MIN_INTERVAL_MS;
  return {
    cognitive: state.lastCognitiveAt === undefined || now - state.lastCognitiveAt >= cognitiveMs,
    research: state.lastResearchAt === undefined || now - state.lastResearchAt >= researchMs,
  };
}

/** 2.0.7：与 sidecar 侧蒸馏定时器共用一把锁——两条入口不并发跑同一弧。 */
export async function runWithArcLock<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  ensureDirSync(stateDir());
  try {
    const value = await withFileLock({ lockPath: arcLockPath(), timeoutMs: 0 }, fn);
    return { ok: true, value };
  } catch (err) {
    console.log('[distill] 弧锁被占用，本次跳过:', err instanceof Error ? err.message : String(err));
    return { ok: false };
  }
}

export interface DistillTickOptions {
  now?: () => number;
  /** 测试注入：跑弧（缺省动态 import 真实现）。 */
  runCognitive?: () => Promise<unknown>;
  runResearch?: () => Promise<unknown>;
  /** 测试注入：状态（缺省读盘）。 */
  state?: ArcState;
  /** 测试注入：是否落盘状态（缺省 true；测试传 false 避免写真实数据目录）。 */
  persist?: boolean;
  /** 测试注入：锁文件路径（缺省真实数据目录）。 */
  lockPath?: string;
}

/**
 * 跑一次节律检查（导出以便单测/手动触发）。
 * 锁内执行；锁被占用（cron 正在跑）→ 本轮跳过。
 */
export async function runDistillTick(options: DistillTickOptions = {}): Promise<{
  skipped: boolean;
  cognitive: boolean;
  research: boolean;
}> {
  const now = (options.now ?? Date.now)();
  const state = options.state ?? readArcState();
  const due = dueArcs(state, now);
  if (!due.cognitive && !due.research) return { skipped: true, cognitive: false, research: false };

  ensureDirSync(stateDir());
  try {
    return await withFileLock({ lockPath: options.lockPath ?? arcLockPath(), timeoutMs: 0 }, async () => {
      const next: ArcState = { ...state };
      let cognitive = false;
      let research = false;
      if (due.cognitive) {
        try {
          if (options.runCognitive) await options.runCognitive();
          else {
            const { runDistillArc, resolveDistillHostWorkspace } = await import('./distill-runner');
            await runDistillArc({ workspacePath: resolveDistillHostWorkspace().path });
          }
          next.lastCognitiveAt = now;
          cognitive = true;
        } catch (err) {
          console.warn('[distill-timer] 认知弧失败:', err instanceof Error ? err.message : String(err));
        }
      }
      if (due.research) {
        try {
          if (options.runResearch) await options.runResearch();
          else {
            const { runResearchDistillArc, resolveDistillHostWorkspace } = await import('./distill-runner');
            await runResearchDistillArc({ workspacePath: resolveDistillHostWorkspace().path });
          }
          next.lastResearchAt = now;
          research = true;
        } catch (err) {
          console.warn('[distill-timer] 安全弧失败:', err instanceof Error ? err.message : String(err));
        }
      }
      if ((cognitive || research) && options.persist !== false) writeArcState(next);
      if (cognitive || research) console.log(`[distill-timer] 已跑：认知弧=${cognitive} 安全弧=${research}`);
      return { skipped: false, cognitive, research };
    });
  } catch (err) {
    // 锁被占用（timeoutMs: 0 直接抛）——cron 路径正在跑，本轮让路
    console.log('[distill-timer] 锁被占用（cron 蒸馏在跑？），本轮跳过:', err instanceof Error ? err.message : String(err));
    return { skipped: true, cognitive: false, research: false };
  }
}

/** 受护定时器：上一轮未结束不重入；unref 不阻塞退出。 */
export function startDistillTimer(): NodeJS.Timeout {
  let running = false;
  const kick = () => {
    if (running) return;
    running = true;
    void runDistillTick()
      .catch((err) => console.warn('[distill-timer] tick 异常:', err instanceof Error ? err.message : String(err)))
      .finally(() => { running = false; });
  };
  const timer = setInterval(kick, DISTILL_TIMER_INTERVAL_MS);
  timer.unref?.();
  const first = setTimeout(kick, DISTILL_TIMER_FIRST_DELAY_MS);
  first.unref?.();
  return timer;
}

/** 数据目录就绪性（诊断用：定时器要能写状态文件）。 */
export function distillTimerReady(): boolean {
  return existsSync(getZhiShiDataDir());
}
