/**
 * M2 — session(loop/session.ts)unit tests.
 *
 * 全部落真临时目录(绝不碰 ~/.zhishi)。覆盖:id 生成与文件名安全化、
 * 序列化/解析往返、坏行容错、归一化(自定义消息类型过滤)、写读往返、
 * meta 创建与更新(createdAt 保留/updatedAt 刷新)、锁并发追加无丢更新、
 * 不存在会话返回空。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import {
  appendLoopMessages,
  loadLoopSession,
  loopSessionFile,
  newLoopSessionId,
  normalizeMessagesForPersist,
  parseLoopSession,
  parseLoopSessionLine,
  serializeLoopSession,
} from './session';

const DIR = mkdtempSync(join(tmpdir(), 'zhishi-loop-session-test-'));

afterAll(() => {
  rmSync(DIR, { recursive: true, force: true });
});

function user(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: 1 } as AgentMessage;
}
function assistant(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'stop',
    timestamp: 2,
  } as unknown as AgentMessage;
}

describe('newLoopSessionId / loopSessionFile', () => {
  it('id 唯一且可排序(时间前缀)', () => {
    const a = newLoopSessionId();
    const b = newLoopSessionId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[a-z0-9]+-[0-9a-f]{12}$/);
  });

  it('文件名安全化:路径穿越字符被剥掉', () => {
    const file = loopSessionFile('../../etc/passwd', DIR);
    expect(file).toBe(join(DIR, 'etcpasswd.jsonl'));
  });
});

describe('serialize / parse 往返', () => {
  it('meta + messages 往返一致', () => {
    const meta = { model: 'k3', providerId: 'moonshot-coding', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
    const msgs = [user('hi'), assistant('hello')];
    const parsed = parseLoopSession(serializeLoopSession(meta, msgs));
    expect(parsed.meta).toEqual(meta);
    expect(parsed.messages).toEqual(msgs);
  });

  it('坏行容错:损坏 JSON/非法 role/kind 跳过,好行保留', () => {
    const good = JSON.stringify(user('keep'));
    const content = [
      '{"kind":"meta","model":"k3","createdAt":"c","updatedAt":"u"}',
      good,
      '{not json',
      '{"role":"bashExecution","command":"x"}',
      '',
      'null',
    ].join('\n');
    const parsed = parseLoopSession(content);
    expect(parsed.meta?.model).toBe('k3');
    expect(parsed.messages).toHaveLength(1);
    expect((parsed.messages[0] as { content: string }).content).toBe('keep');
  });

  it('parseLoopSessionLine:meta 行字段缺省容忍', () => {
    const r = parseLoopSessionLine('{"kind":"meta"}');
    expect(r).toEqual({ kind: 'meta', meta: { model: undefined, providerId: undefined, createdAt: '', updatedAt: '' } });
    expect(parseLoopSessionLine('42')).toBeNull();
    expect(parseLoopSessionLine('')).toBeNull();
  });
});

describe('normalizeMessagesForPersist', () => {
  it('自定义消息类型被过滤,标准三类保留', () => {
    const custom = { role: 'bashExecution', command: 'ls' } as unknown as AgentMessage;
    const toolResult = { role: 'toolResult', toolCallId: 't', toolName: 'env_exec', content: [], isError: false, timestamp: 3 } as unknown as AgentMessage;
    const out = normalizeMessagesForPersist([user('u'), custom, assistant('a'), toolResult]);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'toolResult']);
  });
});

describe('append / load(真临时目录)', () => {
  it('不存在 → 空会话', () => {
    const s = loadLoopSession('nope', { dir: DIR });
    expect(s).toEqual({ messages: [], meta: null });
  });

  it('写读往返;meta 自动创建', async () => {
    const id = newLoopSessionId();
    await appendLoopMessages(id, [user('q1'), assistant('a1')], { model: 'k3', providerId: 'moonshot-coding' }, { dir: DIR });
    const s = loadLoopSession(id, { dir: DIR });
    expect(s.messages).toHaveLength(2);
    expect(s.meta?.model).toBe('k3');
    expect(s.meta?.createdAt).toBeTruthy();
    expect(s.meta?.updatedAt).toBeTruthy();
  });

  it('二次追加:消息累加、createdAt 保留、updatedAt 刷新、model 不覆盖', async () => {
    const id = newLoopSessionId();
    await appendLoopMessages(id, [user('q1')], { model: 'k3' }, { dir: DIR });
    const first = loadLoopSession(id, { dir: DIR });
    await new Promise((r) => setTimeout(r, 5));
    await appendLoopMessages(id, [assistant('a1')], undefined, { dir: DIR });
    const second = loadLoopSession(id, { dir: DIR });
    expect(second.messages).toHaveLength(2);
    expect(second.meta?.createdAt).toBe(first.meta?.createdAt);
    expect(second.meta!.updatedAt >= first.meta!.updatedAt).toBe(true);
    expect(second.meta?.model).toBe('k3');
  });

  it('持久化前归一化:自定义类型不落盘', async () => {
    const id = newLoopSessionId();
    const custom = { role: 'bashExecution', command: 'x' } as unknown as AgentMessage;
    await appendLoopMessages(id, [user('u'), custom], undefined, { dir: DIR });
    const raw = readFileSync(loopSessionFile(id, DIR), 'utf-8');
    expect(raw).not.toContain('bashExecution');
    expect(loadLoopSession(id, { dir: DIR }).messages).toHaveLength(1);
  });

  it('锁并发:N 路并发追加无丢更新', async () => {
    const id = newLoopSessionId();
    const N = 8;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        appendLoopMessages(id, [user(`msg-${i}`)], undefined, { dir: DIR })),
    );
    const s = loadLoopSession(id, { dir: DIR });
    expect(s.messages).toHaveLength(N);
    const contents = s.messages.map((m) => (m as { content: string }).content).sort();
    expect(contents).toEqual(Array.from({ length: N }, (_, i) => `msg-${i}`).sort());
  });

  it('磁盘上已有坏行:追加后坏行被清、好行保留', async () => {
    const id = newLoopSessionId();
    writeFileSync(loopSessionFile(id, DIR), '{broken\n' + JSON.stringify(user('good')) + '\n');
    await appendLoopMessages(id, [assistant('new')], undefined, { dir: DIR });
    const s = loadLoopSession(id, { dir: DIR });
    expect(s.messages).toHaveLength(2);
    expect(s.meta).not.toBeNull();
  });
});
