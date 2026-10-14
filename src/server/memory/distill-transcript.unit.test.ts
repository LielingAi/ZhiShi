/**
 * chain-audit #11 回归：蒸馏/土匪回路的 transcript 消费——pi 时代会话只写
 * loop-sessions/<loopSessionId>.jsonl（sessions/ 目录自 D25 起零新增），
 * 读侧必须两源兼容（绑定优先、旧文件兜底），且 pi 轨迹的块数组 content 与
 * 数字时间戳要正确展开/解析。
 *
 * 修复前形态：sessionExcerpt 只读 sessions/<UUID>.jsonl（pi 会话恒取空）、
 * recallContext 只扫 sessions/ 且只收字符串 content + ISO 时间戳（pi 行全滤掉）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 与既有 distill-runner.unit.test.ts 同形态：网络解析层与重模块 mock 掉。
vi.mock('../loop/pi-provider', () => ({
  resolveLoopModel: () => null,
  resolveLoopModelFromEnv: () => null,
}));
vi.mock('../agent-session', () => ({
  getSessionModel: () => 'm',
  getSessionProviderEnv: () => undefined,
}));

import { sessionExcerpt, recallContext } from './distill-runner';

let dir = '';
let savedEnv: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'distill-traj-'));
  savedEnv = process.env.ZHISHI_DATA_DIR;
  process.env.ZHISHI_DATA_DIR = dir;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.ZHISHI_DATA_DIR;
  else process.env.ZHISHI_DATA_DIR = savedEnv;
  rmSync(dir, { recursive: true, force: true });
});

/** pi 格式轨迹：meta + system-prompt + user（字符串 content、数字时间戳）+
 *  assistant（块数组：thinking + text，数字时间戳）。 */
function writePiTrajectory(loopSessionId: string, ts: number) {
  const dirPath = join(dir, 'loop-sessions');
  mkdirSync(dirPath, { recursive: true });
  const lines = [
    JSON.stringify({ kind: 'meta', model: 'deepseek-flash' }),
    JSON.stringify({ kind: 'system-prompt', hash: 'x', content: 'sys' }),
    JSON.stringify({ role: 'user', content: '查一下目标 10.0.0.8 的开放端口', timestamp: ts }),
    JSON.stringify({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '先扫端口' },
        { type: 'text', text: '22/80 开放，先看 Web 服务' },
      ],
      timestamp: ts + 1000,
    }),
  ];
  writeFileSync(join(dirPath, `${loopSessionId}.jsonl`), lines.join('\n') + '\n');
}

function writeLegacySession(id: string, isoTs: string) {
  const dirPath = join(dir, 'sessions');
  mkdirSync(dirPath, { recursive: true });
  const lines = [
    JSON.stringify({ role: 'user', content: '旧会话的用户消息', timestamp: isoTs }),
    JSON.stringify({ role: 'assistant', content: '旧会话的 AI 回复', timestamp: isoTs }),
  ];
  writeFileSync(join(dirPath, `${id}.jsonl`), lines.join('\n') + '\n');
}

describe('sessionExcerpt（两源兼容）', () => {
  it('pi 轨迹（loop-sessions 绑定 + 块数组 + 数字时间戳）→ 取到尾部摘录', () => {
    writePiTrajectory('mabc123', Date.now());
    const out = sessionExcerpt({ id: 'uuid-1', loopSessionId: 'mabc123' });
    expect(out).toContain('查一下目标 10.0.0.8 的开放端口');
    expect(out).toContain('22/80 开放，先看 Web 服务');
    // thinking 块不进入摘录
    expect(out).not.toContain('先扫端口');
  });

  it('无 loopSessionId 绑定的旧会话 → legacy sessions/ 兜底仍工作（回归守护）', () => {
    writeLegacySession('uuid-2', new Date().toISOString());
    const out = sessionExcerpt({ id: 'uuid-2' });
    expect(out).toContain('旧会话的用户消息');
    expect(out).toContain('旧会话的 AI 回复');
  });

  it('绑定存在但轨迹文件缺失 → 回落 legacy 文件', () => {
    writeLegacySession('uuid-3', new Date().toISOString());
    const out = sessionExcerpt({ id: 'uuid-3', loopSessionId: 'mnotexist' });
    expect(out).toContain('旧会话的用户消息');
  });

  it('两源都没有 → 空串（不炸）', () => {
    expect(sessionExcerpt({ id: 'uuid-none' })).toBe('');
  });
});

describe('recallContext（时间窗证据，双源双格式）', () => {
  it('pi 轨迹的数字时间戳行进窗口；旧格式 ISO 行进窗口；窗口外不进', () => {
    const ts = Date.now();
    writePiTrajectory('mabc123', ts);
    writeLegacySession('uuid-old', new Date(ts + 60_000).toISOString());
    const out = recallContext(ts, 2 * 3600 * 1000);
    expect(out).toContain('查一下目标 10.0.0.8 的开放端口');
    expect(out).toContain('22/80 开放，先看 Web 服务');
    expect(out).toContain('旧会话的用户消息');
  });

  it('窗口外的行不进', () => {
    const ts = Date.now();
    writePiTrajectory('mabc123', ts - 48 * 3600 * 1000); // 两天前，远超窗口
    const out = recallContext(ts, 2 * 3600 * 1000);
    expect(out).toBe('');
  });
});
