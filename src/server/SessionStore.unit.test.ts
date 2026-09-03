/**
 * SessionStore 直接单元测试（debt #3：此前只被 mock 或契约仿写覆盖）。
 *
 * SessionStore 在模块加载时把 ZHISHI_DIR / SESSIONS_FILE 等常量定死
 * （读 process.env.ZHISHI_DATA_DIR），因此每个用例：
 *   1. mkdtemp 一个临时数据目录并设置 ZHISHI_DATA_DIR；
 *   2. vi.resetModules() 后动态 import，拿到绑定临时目录的全新模块实例
 *      （同时重置 lineCountCache 这个模块级缓存）。
 * 全程不碰真实 ~/.zhishi。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionMessage, SessionMetadata } from './types/session';

type Store = typeof import('./SessionStore');

let dataDir: string;
let prevDataDir: string | undefined;
let store: Store;

function makeMsg(id: string, role: 'user' | 'assistant' = 'user', extra: Partial<SessionMessage> = {}): SessionMessage {
  return {
    id,
    role,
    content: `content-of-${id}`,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

function sessionsFile(): string {
  return join(dataDir, 'sessions.json');
}

function jsonlFile(sessionId: string): string {
  return join(dataDir, 'sessions', `${sessionId}.jsonl`);
}

function legacyFile(sessionId: string): string {
  return join(dataDir, 'sessions', `${sessionId}.json`);
}

function readJsonlIds(sessionId: string): string[] {
  return readFileSync(jsonlFile(sessionId), 'utf-8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => (JSON.parse(l) as SessionMessage).id);
}

beforeEach(async () => {
  prevDataDir = process.env.ZHISHI_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'session-store-test-'));
  process.env.ZHISHI_DATA_DIR = dataDir;
  vi.resetModules();
  store = await import('./SessionStore');
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  if (prevDataDir === undefined) delete process.env.ZHISHI_DATA_DIR;
  else process.env.ZHISHI_DATA_DIR = prevDataDir;
});

describe('createSession / getAllSessionMetadata（索引读写）', () => {
  it('空目录 → 空索引；createSession 落盘默认字段', async () => {
    expect(store.getAllSessionMetadata()).toEqual([]);

    const s = await store.createSession('E:/work/a');
    expect(s.title).toBe('New Chat');
    expect(s.runtime).toBe('builtin');
    expect(s.unifiedSession).toBe(true);
    expect(s.agentDir).toBe('E:/work/a');

    const onDisk = JSON.parse(readFileSync(sessionsFile(), 'utf-8')) as SessionMetadata[];
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].id).toBe(s.id);
    expect(store.getSessionMetadata(s.id)?.id).toBe(s.id);
  });

  it('snapshot 字段透传（model / permissionMode / configSnapshotAt）', async () => {
    const s = await store.createSession('E:/work/a', {
      model: 'k2',
      permissionMode: 'auto',
      configSnapshotAt: '2026-01-01T00:00:00.000Z',
    });
    const meta = store.getSessionMetadata(s.id);
    expect(meta?.model).toBe('k2');
    expect(meta?.permissionMode).toBe('auto');
    expect(meta?.configSnapshotAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('损坏容忍（corrupt-file recovery）', () => {
  it('sessions.json 损坏 → getAllSessionMetadata 返回 []', () => {
    store.getAllSessionMetadata(); // 触发目录创建
    writeFileSync(sessionsFile(), '{broken json', 'utf-8');
    expect(store.getAllSessionMetadata()).toEqual([]);
  });

  it('sessions.json 磁盘非空但读出 [] → saveSessionMetadata 拒绝覆写（防全量清库）', async () => {
    store.getAllSessionMetadata();
    writeFileSync(sessionsFile(), '{broken json', 'utf-8');

    const s = await store.createSession('E:/work/a');
    void s;
    // 文件内容必须仍是损坏原文——拒绝写保护生效
    expect(readFileSync(sessionsFile(), 'utf-8')).toBe('{broken json');
  });

  it('JSONL 单行损坏被跳过，其余消息仍可读', async () => {
    const s = await store.createSession('E:/work/a');
    await store.saveSessionMessages(s.id, [makeMsg('m1'), makeMsg('m2')]);
    // 追加一行坏数据
    writeFileSync(jsonlFile(s.id), readFileSync(jsonlFile(s.id), 'utf-8') + 'not-json\n', 'utf-8');

    const data = store.getSessionData(s.id);
    expect(data?.messages.map(m => m.id)).toEqual(['m1', 'm2']);
  });

  it('未知 sessionId → getSessionData 返回 null（不抛）', () => {
    expect(store.getSessionData('no-such-session')).toBeNull();
  });
});

describe('sessionId 校验（路径穿越防护）', () => {
  it('saveSessionMessages 对非法 id 直接 reject', async () => {
    await expect(store.saveSessionMessages('../evil', [makeMsg('m1')])).rejects.toThrow(/Invalid session ID/);
    await expect(store.saveSessionMessages('a/b', [makeMsg('m1')])).rejects.toThrow(/Invalid session ID/);
  });
});

describe('saveSessionMessages（增量 append 契约）', () => {
  it('增量 append：只追加新消息，stats 累计 user 计数与 token', async () => {
    const s = await store.createSession('E:/work/a');
    const m1 = makeMsg('m1');
    const m2 = makeMsg('m2', 'assistant', { usage: { inputTokens: 100, outputTokens: 50 } });
    const m3 = makeMsg('m3');

    await store.saveSessionMessages(s.id, [m1, m2]);
    await store.saveSessionMessages(s.id, [m1, m2, m3]); // 重复传完整数组，只追加 m3

    expect(readJsonlIds(s.id)).toEqual(['m1', 'm2', 'm3']);

    const meta = store.getSessionMetadata(s.id);
    expect(meta?.stats?.messageCount).toBe(2); // m1 + m3 两条 user
    expect(meta?.stats?.totalInputTokens).toBe(100);
    expect(meta?.stats?.totalOutputTokens).toBe(50);
  });

  it('cache token 全零时 stats 字段为 undefined（不落 0 值）', async () => {
    const s = await store.createSession('E:/work/a');
    await store.saveSessionMessages(s.id, [
      makeMsg('m1', 'assistant', { usage: { inputTokens: 1, outputTokens: 1 } }),
    ]);
    const meta = store.getSessionMetadata(s.id);
    expect(meta?.stats?.totalCacheReadTokens).toBeUndefined();
    expect(meta?.stats?.totalCacheCreationTokens).toBeUndefined();
  });

  it('默认 allowShrink：数组变短 → 全量重写 + stats 重算（rewind 语义）', async () => {
    const s = await store.createSession('E:/work/a');
    await store.saveSessionMessages(s.id, [makeMsg('m1'), makeMsg('m2'), makeMsg('m3')]);
    await store.saveSessionMessages(s.id, [makeMsg('m1')]);

    expect(readJsonlIds(s.id)).toEqual(['m1']);
    expect(store.getSessionMetadata(s.id)?.stats?.messageCount).toBe(1);
  });

  it('allowShrink:false 时短数组拒绝覆写，磁盘数据原样保留（防部分加载清尾）', async () => {
    const s = await store.createSession('E:/work/a');
    await store.saveSessionMessages(s.id, [makeMsg('m1'), makeMsg('m2'), makeMsg('m3')]);
    await store.saveSessionMessages(s.id, [makeMsg('m1')], { allowShrink: false });

    expect(readJsonlIds(s.id)).toEqual(['m1', 'm2', 'm3']);
    expect(store.getSessionMetadata(s.id)?.stats?.messageCount).toBe(3);
  });

  it('并发写同一 session 被 per-session 锁串行化：不产生重复行', async () => {
    const s = await store.createSession('E:/work/a');
    const msgs = [makeMsg('m1'), makeMsg('m2')];

    // 无论谁先拿锁，最终文件都必须是恰好两行（后到者看到 existingCount=2 → no-op）。
    await Promise.all([
      store.saveSessionMessages(s.id, msgs),
      store.saveSessionMessages(s.id, msgs),
    ]);

    expect(readJsonlIds(s.id)).toEqual(['m1', 'm2']);
  });

  it('并发 updateSessionMetadata 不丢彼此字段（锁内 read-modify-write，review F3）', async () => {
    const s = await store.createSession('E:/work/a');
    await Promise.all([
      store.updateSessionMetadata(s.id, { title: 'T' }),
      store.updateSessionMetadata(s.id, { favorite: true }),
    ]);
    const meta = store.getSessionMetadata(s.id);
    expect(meta?.title).toBe('T');
    expect(meta?.favorite).toBe(true);
  });
});

describe('legacy JSON → JSONL 迁移', () => {
  it('只有 legacy 文件：读取时迁移，legacy 删除，jsonl 生成', async () => {
    const s = await store.createSession('E:/work/a');
    store.getAllSessionMetadata();
    const legacy = [makeMsg('old1'), makeMsg('old2')];
    writeFileSync(legacyFile(s.id), JSON.stringify({ messages: legacy }), 'utf-8');

    const data = store.getSessionData(s.id);
    expect(data?.messages.map(m => m.id)).toEqual(['old1', 'old2']);
    expect(existsSync(legacyFile(s.id))).toBe(false);
    expect(readJsonlIds(s.id)).toEqual(['old1', 'old2']);
  });

  it('jsonl 与 legacy 并存：优先读 JSONL（legacy 清理由 migrateToJsonl 负责，见报告疑点）', async () => {
    const s = await store.createSession('E:/work/a');
    await store.saveSessionMessages(s.id, [makeMsg('new1')]);
    writeFileSync(legacyFile(s.id), JSON.stringify({ messages: [makeMsg('old1')] }), 'utf-8');

    const data = store.getSessionData(s.id);
    expect(data?.messages.map(m => m.id)).toEqual(['new1']);
  });
});

describe('deleteSession', () => {
  it('删除元数据 + jsonl + legacy；返回 true；不存在返回 false', async () => {
    const s = await store.createSession('E:/work/a');
    await store.saveSessionMessages(s.id, [makeMsg('m1')]);

    expect(await store.deleteSession(s.id)).toBe(true);
    expect(store.getSessionMetadata(s.id)).toBeNull();
    expect(existsSync(jsonlFile(s.id))).toBe(false);

    expect(await store.deleteSession(s.id)).toBe(false);
  });
});

describe('updateSessionMetadata（锁内 read-modify-write + CAS 守卫）', () => {
  it('补丁字段合并写回并返回更新后对象', async () => {
    const s = await store.createSession('E:/work/a');
    const updated = await store.updateSessionMetadata(s.id, { title: 'Renamed', favorite: true });
    expect(updated?.title).toBe('Renamed');
    expect(updated?.favorite).toBe(true);
    expect(store.getSessionMetadata(s.id)?.title).toBe('Renamed');
  });

  it('precondition 失败 → 返回 null 且不落盘（CAS 语义）', async () => {
    const s = await store.createSession('E:/work/a');
    const result = await store.updateSessionMetadata(
      s.id,
      { title: 'auto-title' },
      current => current.title === 'user-renamed', // 实际还是 'New Chat' → 守卫拒绝
    );
    expect(result).toBeNull();
    expect(store.getSessionMetadata(s.id)?.title).toBe('New Chat');
  });

  it('不存在的 session → 返回 null', async () => {
    expect(await store.updateSessionMetadata('nope', { title: 'x' })).toBeNull();
  });
});

describe('getSessionsByAgentDir（过滤 + 排序）', () => {
  it('按 agentDir 过滤、按 lastActiveAt 倒序；非 desktop source 被排除', async () => {
    const a1 = await store.createSession('E:/work/a');
    const a2 = await store.createSession('E:/work/a');
    await store.createSession('E:/work/b');
    const im = await store.createSession('E:/work/a');
    await store.updateSessionMetadata(im.id, { source: 'feishu_private' as SessionMetadata['source'] });

    await store.updateSessionMetadata(a1.id, { lastActiveAt: '2026-01-01T00:00:00.000Z' });
    await store.updateSessionMetadata(a2.id, { lastActiveAt: '2026-06-01T00:00:00.000Z' });

    const list = store.getSessionsByAgentDir('E:/work/a');
    expect(list.map(s => s.id)).toEqual([a2.id, a1.id]);
  });
});

describe('updateSessionTitleFromMessage', () => {
  it('title 为 New Chat 时从首条消息派生标题；已改名则不覆盖', async () => {
    const s = await store.createSession('E:/work/a');
    await store.updateSessionTitleFromMessage(s.id, '帮我审计这个目标的鉴权逻辑');
    const titled = store.getSessionMetadata(s.id);
    expect(titled?.title).not.toBe('New Chat');
    expect(titled?.titleSource).toBe('default');

    await store.updateSessionMetadata(s.id, { title: '用户改的', titleSource: 'user' });
    await store.updateSessionTitleFromMessage(s.id, '另一条消息不应覆盖');
    expect(store.getSessionMetadata(s.id)?.title).toBe('用户改的');
  });
});

describe('calculateSessionStats（纯函数）', () => {
  it('user 计数 + assistant usage 求和', () => {
    const stats = store.calculateSessionStats([
      makeMsg('u1'),
      makeMsg('a1', 'assistant', { usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 } }),
      makeMsg('a2', 'assistant'), // 无 usage 不贡献
      makeMsg('u2'),
    ]);
    expect(stats.messageCount).toBe(2);
    expect(stats.totalInputTokens).toBe(10);
    expect(stats.totalOutputTokens).toBe(5);
    expect(stats.totalCacheReadTokens).toBe(3);
  });
});
