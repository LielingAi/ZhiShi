/**
 * routes/sessions.ts HTTP 路由层直接单元测试（debt #3）。
 *
 * 只测路由契约：请求 → 响应的关键路径与错误映射。下层 SessionStore /
 * chat-engine / env-sessions / agent-session 全部 vi.mock（本层单测不
 * 重复覆盖它们的行为）；session-message-preview 是纯函数，保留真实实现。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JsonResponseFn } from '../cron/routes';

import type { SessionMessage, SessionMetadata } from '../types/session';

const storeMocks = vi.hoisted(() => ({
  deleteSession: vi.fn(),
  getAllSessionMetadata: vi.fn((): SessionMetadata[] => []),
  getSessionData: vi.fn(),
  getSessionsByAgentDir: vi.fn((): SessionMetadata[] => []),
  isDesktopSessionSource: (source?: string) => !source || source === 'desktop',
  updateSessionMetadata: vi.fn(),
}));

const envSessionsMocks = vi.hoisted(() => ({
  loadEnvSessionsMap: vi.fn(() => ({})),
  findEnvKeyForLoopSession: vi.fn((): string | undefined => undefined),
}));

const agentSessionMocks = vi.hoisted(() => ({
  getSessionId: vi.fn(() => 'active-session-id'),
}));

const chatEngineMocks = vi.hoisted(() => ({
  forkPiChat: vi.fn(),
  getPiMessages: vi.fn((): unknown[] => []),
  switchPiSession: vi.fn(),
}));

vi.mock('../SessionStore', () => storeMocks);
vi.mock('../environment/env-sessions', () => envSessionsMocks);
vi.mock('../agent-session', () => agentSessionMocks);
vi.mock('../loop/chat-engine', () => chatEngineMocks);

import {
  handleDeleteSession,
  handleForkSession,
  handleGetSession,
  handleListSessions,
  handlePatchSession,
  handleSwitchSession,
} from './sessions';

const jsonResponse: JsonResponseFn = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function makeMeta(id: string, extra: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    id,
    agentDir: 'E:/work/a',
    title: 'Some Chat',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActiveAt: '2026-01-01T00:00:00.000Z',
    runtime: 'builtin',
    ...extra,
  };
}

function makeMsg(id: string, role: 'user' | 'assistant' = 'user'): SessionMessage {
  return { id, role, content: `content-of-${id}`, timestamp: '2026-01-01T00:00:00.000Z' };
}

function jsonRequest(payload: unknown): Request {
  return new Request('http://localhost/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  storeMocks.getAllSessionMetadata.mockReturnValue([]);
  storeMocks.getSessionsByAgentDir.mockReturnValue([]);
  storeMocks.getSessionData.mockReturnValue(null);
  envSessionsMocks.loadEnvSessionsMap.mockReturnValue({});
  envSessionsMocks.findEnvKeyForLoopSession.mockReturnValue(undefined);
  agentSessionMocks.getSessionId.mockReturnValue('active-session-id');
  chatEngineMocks.getPiMessages.mockReturnValue([]);
});

describe('GET /sessions（handleListSessions）', () => {
  it('无 agentDir：返回全部 desktop 会话，过滤非 desktop source', async () => {
    storeMocks.getAllSessionMetadata.mockReturnValue([
      makeMeta('s1'),
      makeMeta('s2', { source: 'desktop' }),
      makeMeta('im1', { source: 'feishu_private' as SessionMetadata['source'] }),
    ]);

    const res = await handleListSessions(new URL('http://localhost/sessions'), jsonResponse);
    const body = await bodyOf(res);

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect((body.sessions as SessionMetadata[]).map(s => s.id)).toEqual(['s1', 's2']);
  });

  it('providerEnvJson 在响应中被脱敏为 [redacted]', async () => {
    storeMocks.getAllSessionMetadata.mockReturnValue([
      makeMeta('s1', { providerEnvJson: '{"apiKey":"secret"}' }),
    ]);

    const res = await handleListSessions(new URL('http://localhost/sessions'), jsonResponse);
    const [s] = (await bodyOf(res)).sessions as SessionMetadata[];

    expect(s.providerEnvJson).toBe('[redacted]');
  });

  it('带 agentDir：走 getSessionsByAgentDir', async () => {
    storeMocks.getSessionsByAgentDir.mockReturnValue([makeMeta('s9')]);

    const res = await handleListSessions(
      new URL('http://localhost/sessions?agentDir=E:/work/a'),
      jsonResponse,
    );

    expect(storeMocks.getSessionsByAgentDir).toHaveBeenCalledWith('E:/work/a');
    expect(storeMocks.getAllSessionMetadata).not.toHaveBeenCalled();
    expect(((await bodyOf(res)).sessions as SessionMetadata[])[0].id).toBe('s9');
  });

  it('loopSessionId 行补 envKey（additive）；无 loopSessionId 不带该字段', async () => {
    envSessionsMocks.findEnvKeyForLoopSession.mockReturnValue('env:pwn-vm');
    storeMocks.getAllSessionMetadata.mockReturnValue([
      makeMeta('with-loop', { loopSessionId: 'ls-1' }),
      makeMeta('no-loop'),
    ]);

    const res = await handleListSessions(new URL('http://localhost/sessions'), jsonResponse);
    const sessions = (await bodyOf(res)).sessions as Array<SessionMetadata & { envKey?: string }>;

    expect(sessions[0].envKey).toBe('env:pwn-vm');
    expect('envKey' in sessions[1]).toBe(false);
  });

  it('generic 标题 + 外部 runtime：从消息回解 lastMessagePreview', async () => {
    storeMocks.getAllSessionMetadata.mockReturnValue([
      makeMeta('ext1', { title: 'New Chat', runtime: 'codex' as SessionMetadata['runtime'] }),
    ]);
    storeMocks.getSessionData.mockReturnValue({
      ...makeMeta('ext1'),
      messages: [makeMsg('u1'), makeMsg('a1', 'assistant')],
    });

    const res = await handleListSessions(new URL('http://localhost/sessions'), jsonResponse);
    const [s] = (await bodyOf(res)).sessions as SessionMetadata[];

    expect(s.lastMessagePreview).toContain('content-of-u1');
  });

  it('下层抛错 → 500 + success:false', async () => {
    storeMocks.getAllSessionMetadata.mockImplementation(() => {
      throw new Error('disk gone');
    });

    const res = await handleListSessions(new URL('http://localhost/sessions'), jsonResponse);
    const body = await bodyOf(res);

    expect(res.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.error).toBe('disk gone');
  });
});

describe('GET /sessions/:id（handleGetSession）', () => {
  const url = (q = '') => new URL(`http://localhost/sessions/x${q}`);

  it('空 id → 400', async () => {
    const res = await handleGetSession('/sessions/', url(), jsonResponse);
    expect(res.status).toBe(400);
  });

  it('不存在且非活动会话 → 404', async () => {
    const res = await handleGetSession('/sessions/ghost', url(), jsonResponse);
    expect(res.status).toBe(404);
  });

  it('不存在但为当前活动会话 → 200 空会话（in-progress 语义，非 404）', async () => {
    const res = await handleGetSession('/sessions/active-session-id', url(), jsonResponse);
    const body = await bodyOf(res);

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.session).toMatchObject({
      id: 'active-session-id',
      runtime: 'builtin',
      messages: [],
      totalCount: 0,
      hasMoreBefore: false,
    });
  });

  it('命中磁盘会话：全量返回 + totalCount', async () => {
    storeMocks.getSessionData.mockReturnValue({
      ...makeMeta('s1'),
      messages: [makeMsg('m1'), makeMsg('m2', 'assistant')],
    });

    const res = await handleGetSession('/sessions/s1', url(), jsonResponse);
    const session = (await bodyOf(res)).session as Record<string, unknown>;

    expect((session.messages as SessionMessage[]).map(m => m.id)).toEqual(['m1', 'm2']);
    expect(session.totalCount).toBe(2);
    expect(session.hasMoreBefore).toBe(false);
  });

  it('limit=N → 只回最近 N 条，hasMoreBefore 指示更早历史', async () => {
    storeMocks.getSessionData.mockReturnValue({
      ...makeMeta('s1'),
      messages: [makeMsg('m1'), makeMsg('m2'), makeMsg('m3')],
    });

    const res = await handleGetSession('/sessions/s1', url('?limit=2'), jsonResponse);
    const session = (await bodyOf(res)).session as Record<string, unknown>;

    expect((session.messages as SessionMessage[]).map(m => m.id)).toEqual(['m2', 'm3']);
    expect(session.totalCount).toBe(3);
    expect(session.hasMoreBefore).toBe(true);
  });

  it('before 游标：回游标之前的 N 条；过期游标 → 空页让客户端回退全量', async () => {
    storeMocks.getSessionData.mockReturnValue({
      ...makeMeta('s1'),
      messages: [makeMsg('m1'), makeMsg('m2'), makeMsg('m3')],
    });

    const res = await handleGetSession('/sessions/s1', url('?limit=1&before=m3'), jsonResponse);
    const session = (await bodyOf(res)).session as Record<string, unknown>;
    expect((session.messages as SessionMessage[]).map(m => m.id)).toEqual(['m2']);
    expect(session.hasMoreBefore).toBe(true);

    const stale = await handleGetSession('/sessions/s1', url('?limit=1&before=gone'), jsonResponse);
    const staleSession = (await bodyOf(stale)).session as Record<string, unknown>;
    expect(staleSession.messages).toEqual([]);
    expect(staleSession.hasMoreBefore).toBe(false);
  });

  it('活动会话合并内存中未持久化消息：按 id 去重、过滤 tool 角色', async () => {
    storeMocks.getSessionData.mockReturnValue({
      ...makeMeta('active-session-id'),
      messages: [makeMsg('m1')],
    });
    chatEngineMocks.getPiMessages.mockReturnValue([
      { id: 'm1', role: 'user', content: 'dup', timestamp: 't' }, // 已在磁盘 → 去重
      { id: 'tool-1', role: 'tool', content: 'tool out', timestamp: 't' }, // tool 不进本 API
      { id: 'mem-1', role: 'assistant', content: 'partial', timestamp: 't' },
    ]);

    const res = await handleGetSession('/sessions/active-session-id', url(), jsonResponse);
    const session = (await bodyOf(res)).session as Record<string, unknown>;

    expect((session.messages as SessionMessage[]).map(m => m.id)).toEqual(['m1', 'mem-1']);
    expect(session.totalCount).toBe(2);
  });
});

describe('DELETE /sessions/:id（handleDeleteSession）', () => {
  it('空 id → 400；未删到 → 404；删成 → 200', async () => {
    expect((await handleDeleteSession('/sessions/', jsonResponse)).status).toBe(400);

    storeMocks.deleteSession.mockResolvedValue(false);
    expect((await handleDeleteSession('/sessions/ghost', jsonResponse)).status).toBe(404);

    storeMocks.deleteSession.mockResolvedValue(true);
    const ok = await handleDeleteSession('/sessions/s1', jsonResponse);
    expect(ok.status).toBe(200);
    expect((await bodyOf(ok)).success).toBe(true);
    expect(storeMocks.deleteSession).toHaveBeenCalledWith('s1');
  });
});

describe('PATCH /sessions/:id（handlePatchSession）', () => {
  const patch = (id: string, payload: unknown) =>
    handlePatchSession(`/sessions/${id}`, jsonRequest(payload), jsonResponse);

  it('非法 JSON → 400', async () => {
    const bad = new Request('http://localhost/', { method: 'PATCH', body: '{oops' });
    const res = await handlePatchSession('/sessions/s1', bad, jsonResponse);
    expect(res.status).toBe(400);
  });

  it('session 不存在 → 404', async () => {
    storeMocks.updateSessionMetadata.mockResolvedValue(null);
    expect((await patch('ghost', { title: 'x' })).status).toBe(404);
  });

  it('title 截断到 100 字符；改 title 触发 lastActiveAt 刷新', async () => {
    storeMocks.updateSessionMetadata.mockImplementation(async (_id: string, updates: Record<string, unknown>) =>
      makeMeta('s1', updates as Partial<SessionMetadata>));

    await patch('s1', { title: 'x'.repeat(150) });

    const updates = storeMocks.updateSessionMetadata.mock.calls[0][1] as Record<string, unknown>;
    expect((updates.title as string).length).toBe(100);
    expect(typeof updates.lastActiveAt).toBe('string');
  });

  it('favorite 切换不刷 lastActiveAt；false 落为 undefined（磁盘形状最小化）', async () => {
    storeMocks.updateSessionMetadata.mockResolvedValue(makeMeta('s1'));

    await patch('s1', { favorite: false });

    const updates = storeMocks.updateSessionMetadata.mock.calls[0][1] as Record<string, unknown>;
    expect(updates.favorite).toBeUndefined();
    expect('lastActiveAt' in updates).toBe(false);
  });

  it('snapshot 字段 null → 清为 undefined，并盖 configSnapshotAt 时间戳', async () => {
    storeMocks.updateSessionMetadata.mockResolvedValue(makeMeta('s1'));

    await patch('s1', { model: null, providerId: 'p1' });

    const updates = storeMocks.updateSessionMetadata.mock.calls[0][1] as Record<string, unknown>;
    expect(updates.model).toBeUndefined();
    expect(updates.providerId).toBe('p1');
    expect(typeof updates.configSnapshotAt).toBe('string');
  });

  it('响应回显中 providerEnvJson 被脱敏', async () => {
    storeMocks.updateSessionMetadata.mockResolvedValue(
      makeMeta('s1', { providerEnvJson: '{"apiKey":"secret"}' }),
    );

    const res = await patch('s1', { title: 't' });
    const session = (await bodyOf(res)).session as SessionMetadata;

    expect(session.providerEnvJson).toBe('[redacted]');
  });
});

describe('POST /sessions/switch（handleSwitchSession）', () => {
  it('非法 JSON → 400；缺 sessionId → 400', async () => {
    const bad = new Request('http://localhost/', { method: 'POST', body: '{oops' });
    expect((await handleSwitchSession(bad, jsonResponse)).status).toBe(400);
    expect((await handleSwitchSession(jsonRequest({}), jsonResponse)).status).toBe(400);
  });

  it('引擎拒绝 → 404；成功 → 200 + sessionId 回显', async () => {
    chatEngineMocks.switchPiSession.mockResolvedValue(false);
    expect((await handleSwitchSession(jsonRequest({ sessionId: 'ghost' }), jsonResponse)).status).toBe(404);

    chatEngineMocks.switchPiSession.mockResolvedValue(true);
    const res = await handleSwitchSession(jsonRequest({ sessionId: 's1' }), jsonResponse);
    expect(res.status).toBe(200);
    expect((await bodyOf(res)).sessionId).toBe('s1');
  });
});

describe('POST /sessions/fork（handleForkSession）', () => {
  it('缺 messageId → 400；正常 → 透传 forkPiChat 结果', async () => {
    expect((await handleForkSession(jsonRequest({}), jsonResponse)).status).toBe(400);

    chatEngineMocks.forkPiChat.mockResolvedValue({ success: true, sessionId: 'forked' });
    const res = await handleForkSession(jsonRequest({ messageId: 'm1' }), jsonResponse);
    expect((await bodyOf(res)).sessionId).toBe('forked');
    expect(chatEngineMocks.forkPiChat).toHaveBeenCalledWith('m1');
  });
});
