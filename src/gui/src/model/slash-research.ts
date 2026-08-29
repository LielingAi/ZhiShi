/**
 * 1.5.0 触发权归人——研究命令（/intel /archive /decide）的纯模型层。
 * （1.5.1：/expert 斜杠命令随注入面瘦身删除——专家知识改由 harness 按
 * 焦点自动注入，不再需要人手动检索触发。）
 *
 * 背景（用户深度使用实证 + 轨迹取证）：「模型主动」路线实证失败——决策
 * 0 调用、专家 1 会话、档案全靠人打字触发。这些命令把触发权还给人：
 * 人什么时候要查证/要拍板，人自己最知道；模型只需要在被明确要求时执行
 * （轨迹实证：人说了它就做得好）。
 *
 * 通吃上下文（用户拍板）：参数留空时取当前会话上下文——这样给出的才是
 * 有效的（不是泛查）。第一版用规则摘要（最近用户消息截断），不花模型调用。
 *
 * 纯函数零 IO——执行编排（查询 → 拼注入文本 → s.send）在 store。
 */

import type { StreamItem } from './blocks';

/** 上下文缺省查询词：最近一条用户消息文本（截断 160 字）。无上下文 → ''。 */
export function contextQueryFallback(items: StreamItem[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === 'turn' && it.userText.trim()) {
      const t = it.userText.trim().replace(/\s+/g, ' ');
      return t.length > 160 ? `${t.slice(0, 160)}…` : t;
    }
  }
  return '';
}

/** 查询命令的生效查询词：显式参数优先，留空吃上下文。 */
export function effectiveQuery(arg: string, items: StreamItem[]): string {
  const explicit = arg.trim();
  return explicit || contextQueryFallback(items);
}

/** /intel 注入文本（查询结果作为上下文块，与工具结果同席——以 user 消息注入；线索不是结论）。 */
export function buildIntelInjectText(query: string, resultsText: string): string {
  return `【/intel 情报检索 · 查询：${query}】\n${resultsText}\n——以上是应我请求检索的情报（线索不是结论，受影响版本与公开 PoC 需你验证），请结合它继续当前研究。`;
}

/** /archive 固化指令（把用户实证有效的「研究档案建立」手动动作固化成一键）。 */
export const ARCHIVE_INSTRUCTION = `【/archive 整理档案】请回顾本会话近期的研究进展，用 research_archive 工具把研究状态整理进研究档案：
1. 还成立的假设立假设（op=hypothesis）；已被实验证实/推翻的给终态（resolve/falsify/abandon）；
2. 关键实验结果记证据（op=evidence，挂驱动假设引用）；
3. 确认的结论立结论（op=finding，refs 必须挂 V# 证据引用；有反证挂 against）；
4. 还缺什么立未决问题（op=question）；
5. 只整理已有进展，不要开始新的工作。`;

/** /decide 固化指令（反转 request_decision——人要选项时模型产选项卡，人拍板）。 */
export function buildDecideInstruction(topic: string): string {
  const focus = topic.trim() || '当前上下文里最关键的那个抉择（你先判断是什么，在选项卡标题里写清）';
  return `【/decide 给我选项】议题：${focus}
请给出 2-4 个互斥选项（每个：一句话方案 + 关键理由 + 代价/风险），然后用 request_decision 工具提请我拍板。
提请后停下等我的决定，不要边等边推进。`;
}
