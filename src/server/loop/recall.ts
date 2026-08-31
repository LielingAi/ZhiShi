/**
 * 1.5.3 — recall 工具：指针卡的取回面（治本三层分离的「指针 → 流/状态」）。
 *
 * 压缩把段裁成指针卡（段号 + jsonl 行区间 + 收割物 K#N）后,模型「知道
 * 内容在哪」——本工具是唯一的取回通道：
 *   - recall({lines:"x-y"})：按行区间从会话存档 jsonl 取回原文（流）；
 *   - recall({ref:"K#n"})：取回收割物（状态——段的关键行/摘要/用户指令）。
 *
 * 预算纪律：单次取回上限 RECALL_MAX_CHARS（防一次拉回整段把上下文又
 * 顶爆——取回是按需精读,不是全量恢复）；超预算截断并提示缩小行区间。
 * 读侧全容错：文件缺失/坏行/区间越界都返回可读的说明文本,不 throw。
 */

import { existsSync, readFileSync } from 'node:fs';

import { Type, type Static } from '@earendil-works/pi-ai';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';

import { messageText } from './context-manager';
import { readHarvestEntry, type HarvestEntry } from './harvest';
import { defaultLoopSessionDir, loopSessionFile } from './session';

export const RECALL_TOOL_NAME = 'recall';

/** 单次取回字符预算（含行号开销）。 */
export const RECALL_MAX_CHARS = 6000;
/** 单条消息渲染上限（防单条巨型 toolResult 吃掉全部预算）。 */
const RECALL_PER_MESSAGE_MAX = 800;
/** 单次行区间跨度上限（防「取回整份存档」式调用）。 */
const RECALL_MAX_SPAN = 200;

const recallParameters = Type.Object({
  lines: Type.Optional(Type.String({
    description: '会话存档 jsonl 行区间,如 "120-145"（指针卡上标注的行区间;行 1 是 meta 不计）。与 ref 二选一。',
  })),
  ref: Type.Optional(Type.String({
    description: '收割物 id,如 "K#3"（指针卡上的收割引用;取回该段的用户指令/关键行/结论摘要）。与 lines 二选一。',
  })),
});

export type RecallParams = Static<typeof recallParameters>;

export interface RecallToolDetails {
  source: 'lines' | 'ref';
}

export interface CreateRecallToolOptions {
  /** 当前 loop 线（turn 快照线）——取回目标会话。 */
  getSessionId: () => string;
  /** 存储目录（测试注入临时目录;默认 loop-sessions）。 */
  dir?: string;
}

function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** 收割物 → 可读文本（ref 取回形态）。 */
function renderHarvestEntry(entry: HarvestEntry): string {
  const parts = [
    `收割物 ${entry.id}（段#${entry.segmentIndex} ${entry.phase}，jsonl 行 ${entry.lineStart}-${entry.lineEnd}）`,
  ];
  if (entry.userTexts.length > 0) parts.push(`用户指令:${entry.userTexts.map((t) => `「${t}」`).join(' ')}`);
  if (entry.keyFacts.length > 0) parts.push(`关键行:\n${entry.keyFacts.map((l) => `  ${l}`).join('\n')}`);
  if (entry.summaries.length > 0) parts.push(`结论摘要:\n${entry.summaries.map((l) => `  ${l}`).join('\n')}`);
  if (entry.tools.length > 0) parts.push(`工具:${entry.tools.join(' / ')}`);
  if (entry.lineStart > 0 && entry.lineEnd >= entry.lineStart) {
    parts.push(`全文用 recall({lines:"${entry.lineStart}-${entry.lineEnd}"}) 按行区间取回。`);
  }
  return parts.join('\n');
}

/** 解析 "x-y" 行区间（容错:倒序自动交换;非法 → null）。 */
function parseLineRange(raw: string): { start: number; end: number } | null {
  const hit = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(raw);
  if (!hit) return null;
  let start = Number(hit[1]);
  let end = Number(hit[2]);
  if (start > end) [start, end] = [end, start];
  if (start < 2) start = 2; // 行 1 是 meta,不是消息
  return { start, end };
}

/** 构造 recall 工具（harness 原生能力,无条件注册——指针卡的配套取回面）。 */
export function createRecallTool(
  options: CreateRecallToolOptions,
): AgentTool<typeof recallParameters, RecallToolDetails> {
  return {
    name: RECALL_TOOL_NAME,
    label: '取回历史原文',
    description:
      '上下文中被压缩的段以指针卡形式存在（段号 + jsonl 行区间 + 收割物 K#N）。' +
      '需要原文时用本工具取回:lines 按行区间取回原文（如 "120-145"）,ref 按收割物 id 取回摘要与关键行（如 "K#3"）。' +
      '单次取回有字符预算,区间太大会被截断——缩小区间分次精读。',
    parameters: recallParameters,
    execute: async (_toolCallId, params): Promise<AgentToolResult<RecallToolDetails>> => {
      const sessionId = options.getSessionId();
      const dir = options.dir ?? defaultLoopSessionDir();

      if (params.ref) {
        const entry = readHarvestEntry(sessionId, params.ref.trim(), { dir });
        if (!entry) {
          return {
            content: [{ type: 'text', text: `收割物 ${params.ref} 不存在（本会话侧车中无此条目——检查 id 是否形如 K#3）` }],
            details: { source: 'ref' },
          };
        }
        return { content: [{ type: 'text', text: renderHarvestEntry(entry) }], details: { source: 'ref' } };
      }

      if (!params.lines) {
        return {
          content: [{ type: 'text', text: 'recall 需要 lines（行区间 "x-y"）或 ref（收割物 "K#n"）二选一' }],
          details: { source: 'lines' },
        };
      }
      const range = parseLineRange(params.lines);
      if (!range) {
        return {
          content: [{ type: 'text', text: `行区间格式非法:"${params.lines}"——应为 "x-y"（如 "120-145"）` }],
          details: { source: 'lines' },
        };
      }
      if (range.end - range.start + 1 > RECALL_MAX_SPAN) {
        return {
          content: [{ type: 'text', text: `行区间跨度过大（${range.end - range.start + 1} 行 > 上限 ${RECALL_MAX_SPAN}）——缩小区间分次精读` }],
          details: { source: 'lines' },
        };
      }
      const file = loopSessionFile(sessionId, dir);
      if (!existsSync(file)) {
        return { content: [{ type: 'text', text: '会话存档不存在（无 jsonl——本会话还没有持久化历史）' }], details: { source: 'lines' } };
      }
      let rawLines: string[];
      try {
        rawLines = readFileSync(file, 'utf-8').split('\n');
      } catch (err) {
        return {
          content: [{ type: 'text', text: `会话存档读取失败:${err instanceof Error ? err.message : String(err)}` }],
          details: { source: 'lines' },
        };
      }
      if (range.start >= rawLines.length) {
        return {
          content: [{ type: 'text', text: `行区间越界:存档共 ${rawLines.length - 1} 行（含 meta 行 1）,起始行 ${range.start} 超出` }],
          details: { source: 'lines' },
        };
      }
      const end = Math.min(range.end, rawLines.length - 1);
      const out: string[] = [];
      let budget = RECALL_MAX_CHARS;
      let truncated = false;
      for (let n = range.start; n <= end; n++) {
        const raw = rawLines[n - 1] ?? '';
        if (!raw.trim()) continue;
        let rendered: string;
        try {
          const msg = JSON.parse(raw) as { role?: string };
          rendered = `行${n} [${msg.role ?? '?'}] ${clip(messageText(msg as never), RECALL_PER_MESSAGE_MAX)}`;
        } catch {
          rendered = `行${n} [raw] ${clip(raw, 200)}`;
        }
        if (rendered.length + 1 > budget) { truncated = true; break; }
        out.push(rendered);
        budget -= rendered.length + 1;
      }
      if (out.length === 0) {
        return { content: [{ type: 'text', text: `行 ${range.start}-${end} 无内容（空行或越界）` }], details: { source: 'lines' } };
      }
      if (truncated) out.push('⟦recall 预算截断——缩小行区间分次取回⟧');
      return { content: [{ type: 'text', text: out.join('\n') }], details: { source: 'lines' } };
    },
  };
}
