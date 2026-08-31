/**
 * recall.unit.test.ts — 1.5.3 指针取回工具（loop/recall.ts）单测。
 *
 * 覆盖面：ref 取回收割物（命中/未命中）、lines 行区间取回（原文渲染 /
 * 行号 / 区间解析容错 / 跨度上限 / 越界 / 预算截断）、参数缺失提示。
 * 全部走临时目录注入（dir 选项），零真实 IO。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import { appendHarvestEntries } from './harvest';
import { createRecallTool, RECALL_MAX_CHARS, RECALL_TOOL_NAME } from './recall';
import { appendLoopMessages } from './session';

const DIR = mkdtempSync(join(tmpdir(), 'zhishi-recall-test-'));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

function user(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: 1 } as AgentMessage;
}
function assistant(text: string): AgentMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], timestamp: 2 } as unknown as AgentMessage;
}

type ToolResult = { content: Array<{ type: string; text?: string }> };
async function call(tool: ReturnType<typeof createRecallTool>, params: Record<string, unknown>): Promise<string> {
  const r = (await tool.execute('tc', params as never, undefined as never, undefined as never)) as unknown as ToolResult;
  return r.content[0]?.text ?? '';
}

describe('recall 工具', () => {
  it('工具名与注册形态', () => {
    expect(RECALL_TOOL_NAME).toBe('recall');
  });

  it('ref 取回收割物:命中渲染摘要/关键行/行区间;未命中给说明', async () => {
    const sid = 'recall-ref';
    await appendHarvestEntries(sid, [
      { segmentIndex: 2, phase: 'recon', lineStart: 10, lineEnd: 20, userTexts: ['做枚举'], keyFacts: ['exit=0'], summaries: ['攻击面已枚举'], tools: ['env_exec'] },
    ], { dir: DIR });
    const tool = createRecallTool({ getSessionId: () => sid, dir: DIR });
    const hit = await call(tool, { ref: 'K#1' });
    expect(hit).toContain('K#1');
    expect(hit).toContain('攻击面已枚举');
    expect(hit).toContain('做枚举');
    expect(hit).toContain('lines:"10-20"');
    const miss = await call(tool, { ref: 'K#42' });
    expect(miss).toContain('不存在');
  });

  it('lines 取回原文:带行号与角色;倒序区间自动交换;行 1 meta 不可达', async () => {
    const sid = 'recall-lines';
    await appendLoopMessages(sid, [user('第一条用户指令'), assistant('模型回复正文')], undefined, { dir: DIR });
    const tool = createRecallTool({ getSessionId: () => sid, dir: DIR });
    const text = await call(tool, { lines: '2-3' });
    expect(text).toContain('行2 [user] 第一条用户指令');
    expect(text).toContain('行3 [assistant] 模型回复正文');
    // 倒序交换
    const swapped = await call(tool, { lines: '3-2' });
    expect(swapped).toContain('行2 [user]');
    // 行 1 是 meta——起始行被钳到 2
    const clamped = await call(tool, { lines: '1-2' });
    expect(clamped).not.toContain('行1');
    expect(clamped).toContain('行2 [user]');
  });

  it('容错:参数缺失/格式非法/跨度上限/越界/存档缺失', async () => {
    const sid = 'recall-errors';
    await appendLoopMessages(sid, [user('x')], undefined, { dir: DIR });
    const tool = createRecallTool({ getSessionId: () => sid, dir: DIR });
    expect(await call(tool, {})).toContain('二选一');
    expect(await call(tool, { lines: 'abc' })).toContain('格式非法');
    expect(await call(tool, { lines: '2-999' })).toContain('跨度过大');
    expect(await call(tool, { lines: '50-60' })).toContain('越界');
    const ghost = createRecallTool({ getSessionId: () => 'no-such-line', dir: DIR });
    expect(await call(ghost, { lines: '2-5' })).toContain('不存在');
  });

  it('预算截断:超大区间输出受 RECALL_MAX_CHARS 约束并带提示', async () => {
    const sid = 'recall-budget';
    // 60 条 × 700 字符 → 远超预算
    const msgs = Array.from({ length: 60 }, (_, i) => assistant(`回复${i}:` + 'y'.repeat(700)));
    await appendLoopMessages(sid, msgs, undefined, { dir: DIR });
    const tool = createRecallTool({ getSessionId: () => sid, dir: DIR });
    const text = await call(tool, { lines: '2-61' });
    expect(text.length).toBeLessThanOrEqual(RECALL_MAX_CHARS + 200); // 截断提示的固定开销
    expect(text).toContain('预算截断');
  });
});
