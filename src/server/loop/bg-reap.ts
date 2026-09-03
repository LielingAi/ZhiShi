/**
 * env_bg 回收编排（Phase 3 · docs/spec/env-bg-design.md §8）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 【暂定决策 · 接手者先读这段再动】
 *
 * turn 结束（含 Esc 中断）与会话 reset 时，回收杀掉登记表里所有仍在跑
 * 的 bg 进程。这是 2026-08-19 拍板的**暂定决策**，不是终态。为什么暂定：
 *
 *   1. 误杀长任务——turn 结束 ≠ 研究结束。fuzz 长跑/长扫描被 turn 边界
 *      拦腰杀掉，进度只留在环境侧日志里，模型下个 turn 只能重起；
 *      本意是「清场防孤儿积压」，代价是「长任务永远活不过一个 turn」。
 *   2. 研究中断丢进度——Esc 打断的是模型（有时只是打断闲聊），后台跑着
 *      的有用进程被连坐，用户自己都没意识到。
 *   3. 替代模型已在设计底账里备好——「保留续跑 + 认领」：进程在环境里
 *      继续跑（D1 真相在环境内，宿主不杀），新 turn / 重启后的 sidecar
 *      用 tag 认领回句柄（env_bg list 重新发现 + poll 看终态）。这更符合
 *      env_bg「发起即返回句柄、长跑不占 turn」的初衷。
 *
 * 当时选「回收杀掉」的理由：确定性优先——不杀，孤儿进程在环境里积压
 * （模型起一堆监听器/fuzz 忘了 kill，环境资源被吃光）；杀了，最多重跑
 * 一次。若后续要改成「保留续跑」，改动点就是本模块的语义：把「杀」换
 * 成「登记保留 + 不广播 finished」，登记表落盘（bg-registry.ts）已为
 * 跨重启认领就位。
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 容错语义（逐条进单测）：
 *   - 杀成功（reaped）→ 清登记 + 广播 finished(killed)；
 *   - .pid 对不上（环境重启/tag 复用）→ 不杀，清登记 + 广播 finished(dead)；
 *   - 通道失败（ssh 不通）→ 保守：登记保留（下个 turn 结束再试），
 *     不广播 finished（TUI 仍显示跑着——与「探测失败不误杀」同一原则）；
 *   - 环境条目已删 → 够不到，清登记 + 告警（孤儿由环境侧 env_bg list 兜底）。
 *
 * 编排本身不抛错：kill 失败绝不能阻塞 turn 收尾（稳定性红线）。
 */

import type { EnvironmentEntry } from '../../shared/config-types';
import type { BgRegistry } from './bg-registry';

export interface BgReapDeps {
  /** 登记表（list 快照 + remove；测试注入内存实例）。 */
  registry: Pick<BgRegistry, 'list' | 'remove'>;
  /** envId → 环境条目；解析不到（条目已删）→ null。 */
  findEnv: (envId: string) => EnvironmentEntry | null;
  /** 回收 kill（envBgReap 的注入替身）。 */
  reap: (
    entry: EnvironmentEntry,
    tag: string,
    pid: number,
  ) => Promise<{ ok: true; outcome: string } | { ok: false; error: string }>;
  /** 广播 chat:bg-finished（生产接 broadcast；测试收集）。 */
  onFinished: (tag: string, status: 'killed' | 'dead') => void;
  /** 告警输出（生产接 console.warn；测试收集）。 */
  onWarn: (msg: string) => void;
  /** 信息日志（生产接 console.log；测试可省）。 */
  onLog?: (msg: string) => void;
  /**
   * 1.6.0：归属线过滤（loopSessionId）——只回收该线发起的 bg，他线的
   * （auto-run invoke 线 vs 交互线）不被本线 turn 结束连坐。缺省不过滤
   * （reset 语义 = 全收）。ownerSessionId 缺席的旧条目（重启恢复/1.6.0
   * 前登记）归属未知，维持旧口径照收。
   */
  ownerSessionId?: string;
}

export interface BgReapSummary {
  /** 已杀（reaped）并清登记。 */
  killed: number;
  /** 通道失败，登记保留（下轮再试）。 */
  kept: number;
  /** 句柄失效/环境缺失，未杀任何东西但登记已清。 */
  dropped: number;
}

/**
 * 回收登记表里全部 bg 进程。永不 throw（reap 替身抛错也按失败处理）。
 * 遍历的是 list() 快照，迭代中 remove 不影响本次遍历。
 * 1.6.0：deps.ownerSessionId 给定时只回收该归属线的条目（按线过滤）。
 */
export async function reapAllBgProcesses(deps: BgReapDeps): Promise<BgReapSummary> {
  const summary: BgReapSummary = { killed: 0, kept: 0, dropped: 0 };
  // 1.6.0:归属线过滤——登记了归属线且与调用方线不同的条目不碰(他线的
  // bg 继续跑,由它自己的 turn 结束/reset 回收);归属未知(旧条目)照收。
  const entries = deps.registry.list().filter(
    (proc) => !deps.ownerSessionId || !proc.ownerSessionId || proc.ownerSessionId === deps.ownerSessionId,
  );
  if (entries.length === 0) return summary;
  deps.onLog?.(`回收 bg 进程:${entries.length} 条`);

  for (const proc of entries) {
    const entry = deps.findEnv(proc.envId);
    if (!entry) {
      summary.dropped++;
      deps.registry.remove(proc.tag);
      deps.onWarn(`回收 bg 进程 ${proc.tag}:环境 ${proc.envId} 已不存在,清登记(孤儿需在环境侧处理)`);
      continue;
    }

    let r: { ok: true; outcome: string } | { ok: false; error: string };
    try {
      r = await deps.reap(entry, proc.tag, proc.pid);
    } catch (err) {
      r = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!r.ok) {
      // 通道失败（ssh 不通）：登记保留，下个 turn 结束再试；不广播
      // finished——进程可能还活着，不误报已杀（探测失败同一原则）。
      summary.kept++;
      deps.onWarn(`回收 bg 进程 ${proc.tag} 失败(登记保留,下轮再试):${r.error}`);
      continue;
    }
    if (r.outcome.startsWith('reaped')) {
      summary.killed++;
      deps.registry.remove(proc.tag);
      deps.onFinished(proc.tag, 'killed');
    } else {
      // pid-mismatch：句柄已失效（环境重启/tag 复用），没杀任何东西，
      // 但句柄不可再用——登记照清，按「异常消失」广播。
      summary.dropped++;
      deps.registry.remove(proc.tag);
      deps.onFinished(proc.tag, 'dead');
    }
  }
  return summary;
}
