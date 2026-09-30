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
  appendLoopSystemPrompt,
  forkLoopSession,
  loadLoopSession,
  loopSessionFile,
  loopSystemPromptHash,
  markLoopSessionCompacted,
  newLoopSessionId,
  normalizeMessagesForPersist,
  parseLoopSession,
  parseLoopSessionLine,
  serializeLoopSession,
  truncateLoopSession,
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

  it('1.5.3 截断标记剥离:新 ⟦⟧ 与旧 …[已截断] 两种形态都剥(含模型复现到正文中间的——断雪崩环)', () => {
    const legacy = assistant('正文前半…[已截断]');
    const midText = assistant('模型复现:输出像 foo…[已截断] 这样结尾'); // 正文中间的复现
    const current = assistant('正文前半\n⟦系统注记：以下内容已省略，勿复现⟧');
    const thinking = {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: '推理过程\n⟦系统注记：以下内容已省略，勿复现⟧' }],
      timestamp: 2,
    } as unknown as AgentMessage;
    const clean = assistant('没有标记的正文');
    const strMsg = { role: 'user', content: '用户消息…[已截断]', timestamp: 1 } as AgentMessage;
    const out = normalizeMessagesForPersist([legacy, midText, current, thinking, clean, strMsg]);
    expect(JSON.stringify(out)).not.toContain('已截断');
    expect(JSON.stringify(out)).not.toContain('⟦系统注记');
    expect(JSON.stringify(out)).toContain('正文前半');
    expect(JSON.stringify(out)).toContain('模型复现:输出像 foo 这样结尾');
    expect(JSON.stringify(out)).toContain('推理过程');
    expect(JSON.stringify(out)).toContain('用户消息');
  });
});

describe('append / load(真临时目录)', () => {
  it('不存在 → 空会话', () => {
    const s = loadLoopSession('nope', { dir: DIR });
    expect(s).toEqual({ messages: [], meta: null, systemPrompts: [] });
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

  it('1.5.3 tokenCalibration:写入可读回;后续追加不带校准时保留既有值', async () => {
    const id = newLoopSessionId();
    await appendLoopMessages(id, [user('q1')], { tokenCalibration: 3.3 }, { dir: DIR });
    expect(loadLoopSession(id, { dir: DIR }).meta?.tokenCalibration).toBe(3.3);
    await appendLoopMessages(id, [assistant('a1')], undefined, { dir: DIR });
    expect(loadLoopSession(id, { dir: DIR }).meta?.tokenCalibration).toBe(3.3); // ?? 语义:不覆盖
    await appendLoopMessages(id, [assistant('a2')], { tokenCalibration: 2.1 }, { dir: DIR });
    expect(loadLoopSession(id, { dir: DIR }).meta?.tokenCalibration).toBe(2.1); // 显式新值生效
  });

  it('A1-1 回归:markLoopSessionCompacted 不丢 tokenCalibration', async () => {
    const id = newLoopSessionId();
    await appendLoopMessages(id, [user('q1')], { model: 'k3', tokenCalibration: 2.7 }, { dir: DIR });
    await markLoopSessionCompacted(id, { dir: DIR });
    const s = loadLoopSession(id, { dir: DIR });
    expect(s.meta?.compactedAt).toBeTruthy();
    expect(s.meta?.tokenCalibration).toBe(2.7);
    expect(s.meta?.model).toBe('k3');
    expect(s.messages).toHaveLength(1);
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

  it('1.5.3 读侧剥离:盘上烤进去的旧标记(含正文中间的复现)load 时不进上下文', async () => {
    const id = newLoopSessionId();
    // 绕过 normalize(直写盘)模拟事故期落盘的标记
    writeFileSync(
      loopSessionFile(id, DIR),
      JSON.stringify({ kind: 'meta', createdAt: 'x', updatedAt: 'x' }) + '\n'
        + JSON.stringify(user('指令…[已截断]')) + '\n'
        + JSON.stringify(assistant('输出像 foo…[已截断] 这样')) + '\n',
    );
    const s = loadLoopSession(id, { dir: DIR });
    expect(JSON.stringify(s.messages)).not.toContain('已截断');
    expect(s.messages).toHaveLength(2);
  });

  it('轨迹完整性:分段追加(起跑 user + 收尾其余)与一次全量追加同序同内容', async () => {
    // 引擎新语义:turn 起跑先落 [user],收尾再落 [assistant/toolResult...]
    // (doneMessages[0] 去重后)——完成轮的产物必须与旧版单批次逐条一致。
    const msgs = [user('本轮问题'), assistant('本轮回答')];
    const splitId = newLoopSessionId();
    await appendLoopMessages(splitId, [msgs[0]], { model: 'k3', providerId: 'moonshot-coding' }, { dir: DIR });
    await appendLoopMessages(splitId, msgs.slice(1), { model: 'k3', providerId: 'moonshot-coding' }, { dir: DIR });
    const batchId = newLoopSessionId();
    await appendLoopMessages(batchId, msgs, { model: 'k3', providerId: 'moonshot-coding' }, { dir: DIR });
    const split = loadLoopSession(splitId, { dir: DIR });
    const batch = loadLoopSession(batchId, { dir: DIR });
    expect(split.messages).toEqual(batch.messages);
    expect(split.meta?.model).toBe(batch.meta?.model);
    expect(split.meta?.providerId).toBe(batch.meta?.providerId);
  });
});

describe('系统提示记录(轨迹完整性:轨迹要能回答「模型当轮看到了什么」)', () => {
  it('落盘 → load 暴露记录;不进 messages(LLM 永不可见);pos = 写入时消息数', async () => {
    const id = newLoopSessionId();
    await appendLoopMessages(id, [user('q1'), assistant('a1')], undefined, { dir: DIR });
    expect(await appendLoopSystemPrompt(id, '系统提示V1', { dir: DIR })).toBe(true);
    const s = loadLoopSession(id, { dir: DIR });
    expect(s.messages).toHaveLength(2); // 记录不是消息
    expect(s.systemPrompts).toHaveLength(1);
    expect(s.systemPrompts[0].content).toBe('系统提示V1');
    expect(s.systemPrompts[0].hash).toBe(loopSystemPromptHash('系统提示V1'));
    expect(s.systemPrompts[0].pos).toBe(2);
  });

  it('hash 去重:内容不变 → 不重写;变了 → 追加新记录(与末条比,不全局去重)', async () => {
    const id = newLoopSessionId();
    await appendLoopSystemPrompt(id, '提示A', { dir: DIR });
    expect(await appendLoopSystemPrompt(id, '提示A', { dir: DIR })).toBe(false); // 不变不写
    expect(await appendLoopSystemPrompt(id, '提示B', { dir: DIR })).toBe(true); // 变了写
    expect(await appendLoopSystemPrompt(id, '提示A', { dir: DIR })).toBe(true); // 与末条不同即写
    const s = loadLoopSession(id, { dir: DIR });
    expect(s.systemPrompts.map((r) => r.content)).toEqual(['提示A', '提示B', '提示A']);
    // 文件行数侧面验证「不重写」:meta + 3 记录,无消息
    const raw = readFileSync(loopSessionFile(id, DIR), 'utf-8').trim().split('\n');
    expect(raw).toHaveLength(4);
  });

  it('记录先于本批消息:raw 行序 = meta, 记录, user, assistant(pos 交错)', async () => {
    const id = newLoopSessionId();
    // 引擎传 pos = 当轮 user 之前的下标(空历史 → 0),随后 turn 批次追加
    await appendLoopSystemPrompt(id, '提示X', { dir: DIR, pos: 0 });
    await appendLoopMessages(id, [user('q'), assistant('a')], undefined, { dir: DIR });
    const raw = readFileSync(loopSessionFile(id, DIR), 'utf-8').trim().split('\n');
    expect(JSON.parse(raw[0]).kind).toBe('meta');
    expect(JSON.parse(raw[1])).toMatchObject({ kind: 'system-prompt', content: '提示X' });
    expect(JSON.parse(raw[2]).role).toBe('user');
    expect(JSON.parse(raw[3]).role).toBe('assistant');
  });

  it('旧轨迹(无记录行)load 正常(systemPrompts=[]),续写后记录随读-改-写保留', async () => {
    const id = newLoopSessionId();
    writeFileSync(
      loopSessionFile(id, DIR),
      JSON.stringify({ kind: 'meta', createdAt: 'c', updatedAt: 'u' }) + '\n' + JSON.stringify(user('old')) + '\n',
    );
    const s = loadLoopSession(id, { dir: DIR });
    expect(s.systemPrompts).toEqual([]);
    expect(s.messages).toHaveLength(1);
    // 追加记录(默认 pos=当前消息数 1)后再追加消息——全量重写不丢记录、位置不变
    await appendLoopSystemPrompt(id, '提示Y', { dir: DIR });
    await appendLoopMessages(id, [assistant('new')], undefined, { dir: DIR });
    const s2 = loadLoopSession(id, { dir: DIR });
    expect(s2.systemPrompts.map((r) => r.content)).toEqual(['提示Y']);
    expect(s2.messages).toHaveLength(2);
    const raw = readFileSync(loopSessionFile(id, DIR), 'utf-8').trim().split('\n');
    expect(JSON.parse(raw[1]).role).toBe('user');
    expect(JSON.parse(raw[2]).kind).toBe('system-prompt');
    expect(JSON.parse(raw[3]).role).toBe('assistant');
  });

  it('truncate/fork:追加日志截断语义——截点前的记录保留,截点后的丢掉', async () => {
    const id = newLoopSessionId();
    await appendLoopMessages(id, [user('q1'), assistant('a1')], undefined, { dir: DIR });
    await appendLoopSystemPrompt(id, '提示P1', { dir: DIR }); // pos=2(q2 轮的提示)
    await appendLoopMessages(id, [user('q2'), assistant('a2')], undefined, { dir: DIR });
    await appendLoopSystemPrompt(id, '提示P2', { dir: DIR }); // pos=4
    const forkId = await forkLoopSession(id, 2, { dir: DIR });
    const forked = loadLoopSession(forkId, { dir: DIR });
    expect(forked.messages).toHaveLength(2);
    expect(forked.systemPrompts.map((r) => r.content)).toEqual(['提示P1']); // pos=2 ≤ 截点;P2 丢
    await truncateLoopSession(id, 2, { dir: DIR });
    const truncated = loadLoopSession(id, { dir: DIR });
    expect(truncated.messages).toHaveLength(2);
    expect(truncated.systemPrompts.map((r) => r.content)).toEqual(['提示P1']);
  });

  it('记录与截断标记剥除器不碰撞:内容含标记的系统提示原样保留', async () => {
    const id = newLoopSessionId();
    const content = '提示含标记\n⟦系统注记：以下内容已省略，勿复现⟧原样保留';
    await appendLoopSystemPrompt(id, content, { dir: DIR });
    const s = loadLoopSession(id, { dir: DIR });
    expect(s.systemPrompts[0].content).toBe(content); // 记录不是消息,不过 normalize/剥标记
  });
});
