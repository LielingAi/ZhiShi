/**
 * 1.7.2 — 档案纪律（archive discipline）共享层。
 *
 * 档案检查点从 auto-run 专属抽到共享：交互会话同样按轮数确定性注入
 * 「整理研究状态」提示（实机实证：交互线 2 天 1360 消息,archive 仅 8
 * 实体——没有确定性检查点,模型自律失效是结构性的）。置换触发的那轮
 * （工作记忆即将裁剪）额外强制注入（程序决定时机,模型只执行整理）。
 */

/** 交互会话：每 N 个 user 消息（≈ 轮次）注入一次档案检查点。 */
export const INTERACTIVE_ARCHIVE_CHECKPOINT_INTERVAL = 6;

/** 档案检查点文本（auto-run 与交互线共用——1.7.2 自 auto-run 迁入共享层）。 */
export const ARCHIVE_CHECKPOINT_TEXT =
  '【档案检查点】本轮结束前用 research_archive 整理研究状态：在验假设继续推进实验；'
  + '已证实/推翻/不追的假设给终态(resolve/falsify/abandon)；新实验结果记 evidence(挂假设引用)；'
  + '确认的结论 op=finding(refs 挂 V# 证据引用,有反证挂 against)；缺什么立 question。'
  + '关键进展同时用 research_log 留痕(拿到 flag、确认根因、fuzz 出崩溃、卡住都要记)。';

/**
 * 交互检查点判定（纯函数）：user 消息计数 % 间隔 === 0 → 注入;force（置换
 * 触发轮）恒注入。userCount 0 不注入（首轮系统提示已有档案纪律段）。
 */
export function shouldInjectArchiveCheckpoint(userMessageCount: number, force = false): boolean {
  if (userMessageCount <= 0) return false;
  return force || userMessageCount % INTERACTIVE_ARCHIVE_CHECKPOINT_INTERVAL === 0;
}

/** 组装注入行（不注入 → 空串）。 */
export function buildArchiveCheckpointLine(userMessageCount: number, force = false): string {
  return shouldInjectArchiveCheckpoint(userMessageCount, force) ? ARCHIVE_CHECKPOINT_TEXT : '';
}
