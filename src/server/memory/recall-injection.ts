/**
 * 记忆检索事件记账（2.0.7）——把"注入了什么"记成 recall 事件。
 *
 * 背景（2026-10-22 复查）：`logRecallEvents` 全仓只有一个调用点——手工检索
 * 路由 `memory/search`。真正影响模型的那条路（系统提示里注入的蒸馏四段 +
 * 研究记忆三节）**从不记账**，于是 `recall_events` 恒为 0，judge 没有素材，
 * `usefulness` 永远是 1.0、「常用的上浮 / 久不碰下沉 / 被纠正降权」这套
 * 机制整体空转。
 *
 * 语义澄清：注入 ≠ 被使用。judge 本来就是"注入之后，看后续对话窗口里到底
 * 有没有真的用上"（证据窗 -5min~+2h，安全类 24h），所以**注入即记账**是
 * 它设计的前置。这里只负责记账，判定仍由 distill-runner 的 judge 做。
 *
 * 纪律：
 * - 同一 memory 有冷却期（默认 30 分钟），避免每轮刷屏把事件表灌爆；
 * - 单次最多记 MAX_PER_CALL 条；
 * - 全程 best-effort：任何失败都不该影响系统提示组装。
 */

import {
  latestDistilledEntry,
  latestKeyedDistilledEntry,
  listActive,
  logRecallEvents,
} from './store';
import { RESEARCH_DISTILL_SECTIONS, type ResearchDistilledMemory } from './distill-research';
import type { DistilledMemory } from './distill';

/** 同一记忆两次记账的最小间隔。 */
export const INJECTION_RECALL_COOLDOWN_MS = 30 * 60_000;
/** 单次记账上限（防止一次注入把队列灌满）。 */
export const INJECTION_RECALL_MAX_PER_CALL = 8;

const lastLoggedAt = new Map<string, number>();

/** 测试钩子：清冷却表。 */
export function resetInjectionRecallForTests(): void {
  lastLoggedAt.clear();
}

export interface NoteInjectedMemoryOptions {
  /** 测试注入：事件落点（缺省 logRecallEvents）。 */
  log?: (ids: string[], query: string, now: number) => void;
  /** 测试注入：当前时间。 */
  now?: number;
  /** 覆盖冷却期（测试用）。 */
  cooldownMs?: number;
}

/**
 * 记录"这些记忆本轮被注入进上下文"。
 * 返回实际记账的条数（0 = 全在冷却期）。
 */
export function noteInjectedMemory(
  ids: readonly string[],
  query: string,
  options: NoteInjectedMemoryOptions = {},
): number {
  const now = options.now ?? Date.now();
  const cooldown = options.cooldownMs ?? INJECTION_RECALL_COOLDOWN_MS;
  const candidates: string[] = [];
  for (const id of ids) {
    if (!id) continue;
    if (candidates.includes(id)) continue;
    const prev = lastLoggedAt.get(id);
    if (prev !== undefined && now - prev < cooldown) continue;
    candidates.push(id);
  }
  if (candidates.length === 0) return 0;
  // 超上限时按「最久没记过」优先——固定顺序 + 硬截断会让尾巴永远轮不上
  // （注入集合稳定时尤其明显：每次都是前 8 条，后 3 条饿死）。
  candidates.sort((a, b) => (lastLoggedAt.get(a) ?? 0) - (lastLoggedAt.get(b) ?? 0));
  const fresh = candidates.slice(0, INJECTION_RECALL_MAX_PER_CALL);
  for (const id of fresh) lastLoggedAt.set(id, now);
  try {
    if (options.log) options.log(fresh, query, now);
    else logRecallEvents(fresh, query.slice(0, 200), undefined, now);
  } catch {
    /* best-effort：记账失败不影响本轮提示组装 */
  }
  return fresh.length;
}

/** 本轮被注入的蒸馏条目 id（只算真正进了上下文的段）。 */
export function distilledEntryIds(distilled: DistilledMemory | undefined): string[] {
  if (!distilled) return [];
  const ids: string[] = [];
  const push = (id: string | undefined) => { if (id) ids.push(id); };
  if (distilled.userModel.trim()) push(latestDistilledEntry('user-model')?.id);
  if (distilled.selfModel.trim()) push(latestDistilledEntry('self-model')?.id);
  if (distilled.routines.trim()) push(latestDistilledEntry('routines')?.id);
  // reminder 是合并渲染的一整段（文本里没有 id）——段非空即视为整批在场
  if (distilled.reminders.trim()) {
    for (const e of listActive('reminder').slice(0, INJECTION_RECALL_MAX_PER_CALL)) push(e.id);
  }
  return ids;
}

/** 本轮被注入的研究记忆（vuln-pattern / tool-combo 的 keyed 产物）id。 */
export function researchMemoryEntryIds(memory: ResearchDistilledMemory | undefined): string[] {
  if (!memory) return [];
  const ids: string[] = [];
  for (const section of RESEARCH_DISTILL_SECTIONS) {
    if (!memory[section.key].trim()) continue;
    const entry = latestKeyedDistilledEntry(section.kind, section.storeKey);
    if (entry) ids.push(entry.id);
  }
  return ids;
}
