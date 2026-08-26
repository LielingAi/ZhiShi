/**
 * 1.3.3 — loop 会话 wire 回放纯函数。
 *
 * loop-sessions jsonl 里的 pi AgentMessage → GUI/TUI 可直接渲染的 wire
 * 消息(含 1.3.2 决策块 kind:'decision' 的还原)。三条消费路径共用同一
 * 口径,杜绝还原逻辑漂移:
 * - chat-engine 启动/恢复/rewind/fork(loopMessagesToWire);
 * - /chat/stream cold-history replay(经引擎内存消息);
 * - 历史面板只读回看(HTTP `/api/loop-session/messages?format=wire`)。
 *
 * 语义与历史实现一致:thinking 段不重现(紧随的 tool 卡代表这轮动作);
 * 纯空结论的 assistant 照发空 content(渲染层转分隔行兜底);工具结果
 * 重放为 tool 卡。id 是会话内自增序号(重放路径的 id 只要求时间序,
 * 跨恢复/重连不要求与 live 时一致)。
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';

import type { DecisionMeta } from './decision';

/** 回放用 wire 消息(形状与 chat-engine 的 MessageWire 对齐,去掉了
 *  纯 live 标签 queueId)。 */
export interface LoopWireMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: string;
  /** role === 'tool' 时:工具名与成败(重放工具卡用)。 */
  name?: string;
  ok?: boolean;
  attachments?: {
    id: string;
    name: string;
    mimeType: string;
    isImage?: boolean;
  }[];
  /** 1.3.2 决策块:user 消息带 kind='decision' 时为决策记录。 */
  kind?: 'decision';
  decisionId?: string;
  choice?: string;
  note?: string;
  expertRefs?: string[];
}

/**
 * pi AgentMessage[] → wire 消息。
 * @param loopMessages 从 loop jsonl 载入的消息(loadLoopSession)。
 * @param startSeq 起始序号(chat-engine 传当前 messageSeq 保持 live 续号)。
 */
export function buildLoopWireMessages(loopMessages: AgentMessage[], startSeq = 0): LoopWireMessage[] {
  const wire: LoopWireMessage[] = [];
  let seq = startSeq;
  for (const m of loopMessages) {
    if (m.role === 'user') {
      const text = typeof m.content === 'string'
        ? m.content
        : m.content.filter((c): c is TextContent => c.type === 'text').map((c) => c.text).join('\n');
      const images = typeof m.content === 'string'
        ? []
        : m.content.filter((c): c is ImageContent => c.type === 'image');
      // 1.3.2 决策块:loop 持久化的 decision marker → wire kind:'decision'
      // (additive;重放重建琥珀决策块的还原点)。
      const decision = (m as { decision?: DecisionMeta }).decision;
      wire.push({
        id: String(seq++),
        role: 'user',
        content: text,
        timestamp: new Date(m.timestamp || Date.now()).toISOString(),
        ...(images.length > 0
          ? { attachments: images.map((img, i) => ({ id: String(i), name: 'image', mimeType: img.mimeType, isImage: true })) }
          : {}),
        ...(decision
          ? {
              kind: 'decision' as const,
              decisionId: decision.decisionId,
              choice: decision.choice,
              ...(decision.note ? { note: decision.note } : {}),
              ...(decision.expertRefs && decision.expertRefs.length > 0 ? { expertRefs: decision.expertRefs } : {}),
            }
          : {}),
      });
    } else if (m.role === 'assistant') {
      const text = m.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      // 工具调用前的 thinking 段不重放;纯空结论照发空 content。
      if (!text && m.content.some((c) => c.type === 'toolCall')) continue;
      wire.push({
        id: String(seq++),
        role: 'assistant',
        content: text,
        timestamp: new Date(m.timestamp || Date.now()).toISOString(),
      });
    } else if (m.role === 'toolResult') {
      const text = m.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      wire.push({
        id: String(seq++),
        role: 'tool',
        name: typeof m.toolName === 'string' && m.toolName ? m.toolName : 'tool',
        ok: m.isError !== true,
        content: text,
        timestamp: new Date(m.timestamp || Date.now()).toISOString(),
      });
    }
  }
  return wire;
}
