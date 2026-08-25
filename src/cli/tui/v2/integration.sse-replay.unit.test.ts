/**
 * Virtual SSE replay integration test (plan §0.3 / 审计 #18).
 *
 * Goal: prove the full terminal pipeline works end-to-end WITHOUT a real TTY or
 * a running sidecar server. We inject a fake `fetchImpl` that serves a canned
 * SSE byte stream, then exercise:
 *
 *   1. SidecarClient.openSse  → parses the raw SSE frames (real SSEParser path).
 *   2. event-reducer          → folds frames into SessionState.blocks.
 *   3. blocks/* renderers     → turn blocks into styled spans.
 *   4. TerminalWriter         → paint spans onto a captured "screen" sink.
 *
 * Plus a gate track that drives the real gate logic (build/move/commit/resolve)
 * with a fake admin client.
 *
 * No network, no TTY, no process.stdin — safe to run in CI (`vitest run`).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { TextEncoder } from 'node:util';

import { SidecarClient, type FetchLike, type FetchResponseLike, type SseStreamReader } from '../client';
import { reduceSseEvent } from './event-reducer';
import type { SessionState, Block, SseInput, UserBlock, AssistantBlock, ToolBlock } from './types';
import type { Span } from './row-buffer';
import { TerminalWriter } from './terminal-writer';
import { renderAssistant, renderUser } from './blocks/message-block';
import { renderToolFolded } from './blocks/tool-block';
import { buildGateOptions, moveGateCursor, commitGate, type GateOption } from './gate';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal but valid SessionState to reduce into. */
function makeSession(): SessionState {
  return {
    blocks: [],
    streamingId: null,
    queue: [],
    tasks: new Map(),
    status: {
      phase: 'idle',
      queueDepth: 0,
      contextPct: 0,
      model: 'test-model',
      backgroundSeg: undefined,
      envName: 'host',
      envKind: 'env',
      modalActive: false,
    },
    currentTurnId: null,
    pendingDividerId: null,
    seenSrvIds: new Set(),
    bgProcs: new Map(),
    seq: 0,
  };
}

/** Reduce a list of SSE frames into a fresh SessionState. */
function replay(frames: SseInput[]): SessionState {
  const s = makeSession();
  for (const f of frames) reduceSseEvent(s, f);
  return s;
}

function ev(event: string, payload: unknown): SseInput {
  return { event, payload };
}

// ---------------------------------------------------------------------------
// Fake SSE transport
// ---------------------------------------------------------------------------

/** Wrap a full SSE text body into a fetch response that streams it once. */
function sseFetch(body: string): FetchLike {
  const bytes = new TextEncoder().encode(body);
  return (async () => {
    let sent = false;
    const reader: SseStreamReader = {
      cancel: async () => {},
      read: async () => {
        if (!sent) {
          sent = true;
          return { done: false, value: bytes };
        }
        return { done: true };
      },
    };
    const res: FetchResponseLike = {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
      json: async () => ({}),
      text: async () => body,
      body: { getReader: () => reader },
    };
    return res;
  }) as FetchLike;
}

/** Encode a list of {event, data} into an SSE wire body. */
function encodeSse(frames: { event: string; data: unknown }[]): string {
  return frames
    .map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`)
    .join('');
}

// ---------------------------------------------------------------------------
// 1. SidecarClient.openSse → real frame parsing
// ---------------------------------------------------------------------------

describe('SidecarClient virtual SSE replay', () => {
  it('parses a canned SSE stream into distinct frames', async () => {
    const wire = encodeSse([
      { event: 'chat:init', data: { sessionId: 's1', model: 'm', env: { id: 'host' } } },
      { event: 'chat:status', data: { sessionState: { phase: 'running', contextPct: 12 } } },
      { event: 'chat:message-chunk', data: { blockId: 'a1', delta: 'hello' } },
    ]);
    const client = new SidecarClient({ base: 'http://test', fetchImpl: sseFetch(wire) });
    const ctrl = new AbortController();
    const got: string[] = [];
    for await (const frame of client.openSse('/chat/stream', { signal: ctrl.signal })) {
      got.push(frame.event ?? '');
      if (got.length >= 3) ctrl.abort(); // stop after the three frames
    }
    expect(got).toEqual(['chat:init', 'chat:status', 'chat:message-chunk']);
  });
});

// ---------------------------------------------------------------------------
// 2. Reducer: full SSE lifecycle → blocks
// ---------------------------------------------------------------------------

describe('event-reducer lifecycle (virtual replay)', () => {
  it('folds chat:init + thinking + assistant into ordered blocks with complete thought', () => {
    const s = replay([
      ev('chat:init', { sessionId: 's1', model: 'm', env: { id: 'host' } }),
      ev('chat:thinking-start', {}),
      ev('chat:thinking-chunk', { delta: 'hmm' }),
      ev('chat:thinking-complete', { seconds: 3 }),
      ev('chat:message-chunk', { delta: 'Hi ' }),
      ev('chat:message-chunk', { delta: 'there' }),
      ev('chat:message-complete', { usage: { input: 10, output: 4 } }),
    ]);

    const kinds = s.blocks.map((b) => b.kind);
    expect(kinds).toEqual(['thinking', 'assistant']);

    const thought = s.blocks[0] as Extract<Block, { kind: 'thinking' }>;
    expect(thought.text).toBe('hmm');
    expect(thought.streaming).toBe(false);
    expect(thought.complete).toBe(true);
    expect(thought.seconds).toBe(3);

    const asst = s.blocks[1] as Extract<Block, { kind: 'assistant' }>;
    expect(asst.text).toBe('Hi there');
    expect(asst.complete).toBe(true);
    expect(asst.streaming).toBe(false);
    expect(asst.usage).toEqual({ input: 10, output: 4 });
  });

  it('空结论兜底:工具跑完无文字 → 块转分隔行;无工具空回复 → 空回复行', () => {
    const s = replay([
      ev('chat:init', { sessionState: 'idle' }),
      ev('chat:message-chunk', ''),
      ev('chat:tool-use-start', { id: 't1', name: 'env_exec', input: { command: 'seq 1 3' } }),
      ev('chat:tool-result-complete', { toolUseId: 't1', content: '1\n2\n3\n', isError: false }),
      ev('chat:message-complete', {}),
    ]);
    // assistant 块(首块)被转成分隔行;工具卡保留。
    const first = s.blocks[0];
    expect(first.kind).toBe('divider');
    expect((first as Extract<Block, { kind: 'divider' }>).label).toContain('工具调用');
    expect(s.blocks.some((b) => b.kind === 'tool')).toBe(true);

    const s2 = replay([
      ev('chat:init', { sessionState: 'idle' }),
      ev('chat:message-chunk', ''),
      ev('chat:message-complete', {}),
    ]);
    const last2 = s2.blocks[s2.blocks.length - 1];
    expect(last2.kind).toBe('divider');
    expect((last2 as Extract<Block, { kind: 'divider' }>).label).toContain('空回复');
  });

  it('folds pi-engine string deltas + chat:status string into text and phase', () => {
    const s = replay([
      ev('chat:init', { sessionState: 'idle', hasInitialPrompt: false, loopEngine: 'pi' }),
      ev('chat:status', { sessionState: 'running' }),
      ev('chat:message-chunk', 'Hello '),
      ev('chat:message-chunk', 'pi'),
      ev('chat:message-complete', { model: 'm', input_tokens: 42, output_tokens: 7 }),
      ev('chat:status', { sessionState: 'idle' }),
    ]);

    const asst = s.blocks.find((b) => b.kind === 'assistant') as Extract<Block, { kind: 'assistant' }>;
    expect(asst).toBeDefined();
    expect(asst.text).toBe('Hello pi');
    expect(asst.usage).toEqual({ input: 42, output: 7, cacheRead: 0, cacheWrite: 0 });
    expect(s.status.phase).toBe('idle');
  });

  it('folds pi-engine tool payloads ({input}, {toolUseId, content}) into a done tool', () => {
    const s = replay([
      ev('chat:init', { sessionState: 'idle' }),
      ev('chat:tool-use-start', { id: 't1', name: 'env_exec', input: { command: 'uname -a' } }),
      ev('chat:tool-result-complete', { toolUseId: 't1', content: 'Linux box\n', isError: false }),
    ]);

    const tool = s.blocks.find((b) => b.kind === 'tool') as Extract<Block, { kind: 'tool' }>;
    expect(tool).toBeDefined();
    expect(tool.argsSummary).toContain('command=uname -a');
    expect(tool.state).toBe('done');
    expect(tool.output).toBe('Linux box\n');
  });

  it('survives a null chat:message-stopped and confirms the optimistic divider', () => {
    const s = makeSession();
    const divider = {
      id: 'd1',
      kind: 'divider' as const,
      seq: 1,
      label: '── ⏸ 已中断 ──',
      tone: 'interrupt' as const,
    };
    s.blocks.push(divider);
    s.pendingDividerId = 'd1';

    expect(() => reduceSseEvent(s, ev('chat:message-stopped', null))).not.toThrow();
    expect(s.pendingDividerId).toBeNull();
    const d = s.blocks.find((b) => b.id === 'd1') as Extract<Block, { kind: 'divider' }>;
    expect(d.follow).toBe('已停止');
    expect(s.status.phase).toBe('interrupted');
  });

  it('marks an error frame as an error block and sets phase', () => {
    const s = replay([
      ev('chat:init', { sessionId: 's1', model: 'm', env: { id: 'host' } }),
      ev('chat:message-error', { message: 'boom' }),
    ]);
    const err = s.blocks.find((b) => b.kind === 'error');
    expect(err).toBeDefined();
    expect((err as Extract<Block, { kind: 'error' }>).text).toBe('boom');
    expect(s.status.phase).toBe('error');
  });

  it('replays cold history from chat:message-replay as ordered blocks', () => {
    const s = replay([
      ev('chat:init', { sessionId: 's1', model: 'm', env: { id: 'host' } }),
      ev('chat:message-replay', { role: 'user', content: 'past question' }),
      ev('chat:message-replay', { role: 'assistant', content: 'past answer', usage: { input: 5, output: 2 } }),
      ev('chat:message-chunk', { delta: 'new answer' }),
      ev('chat:message-complete', {}),
    ]);
    const userBlocks = s.blocks.filter((b) => b.kind === 'user');
    const asstBlocks = s.blocks.filter((b) => b.kind === 'assistant');
    expect(userBlocks).toHaveLength(1);
    expect(userBlocks[0].text).toBe('past question');
    expect(asstBlocks).toHaveLength(2); // replayed + new
    expect(asstBlocks[0].text).toBe('past answer');
    expect(asstBlocks[1].text).toBe('new answer');
    expect(asstBlocks[0].complete).toBe(true);
  });

  it('replays empty assistant as divider (tool-first → 看工具卡, bare → 空回复)', () => {
    const s = replay([
      ev('chat:init', { sessionId: 's1', model: 'm', env: { id: 'host' } }),
      ev('chat:message-replay', { role: 'user', content: 'q' }),
      ev('chat:message-replay', { role: 'tool', content: 'tool result' }),
      ev('chat:message-replay', { role: 'assistant', content: '' }),
    ]);
    const last = s.blocks[s.blocks.length - 1];
    expect(last.kind).toBe('divider');
    expect((last as Extract<Block, { kind: 'divider' }>).label).toContain('工具调用');
    // 空助手行没有被静默吞掉:一个 user + 一个 tool + 一个 divider。
    expect(s.blocks.map((b) => b.kind)).toEqual(['user', 'tool', 'divider']);

    const s2 = replay([
      ev('chat:init', { sessionId: 's2', model: 'm', env: { id: 'host' } }),
      ev('chat:message-replay', { role: 'user', content: 'q' }),
      ev('chat:message-replay', { role: 'assistant', content: '   ' }),
    ]);
    const last2 = s2.blocks[s2.blocks.length - 1];
    expect(last2.kind).toBe('divider');
    expect((last2 as Extract<Block, { kind: 'divider' }>).label).toContain('空回复');
  });

  it('chat:subagent-started/finished → 状态段 + 结论插行(带切过去尾钩)', () => {
    const s = makeSession();
    const p1 = reduceSseEvent(s, ev('chat:subagent-started', { taskId: 't1', description: 'fuzz 首轮' }));
    expect(s.tasks.get('t1')?.description).toBe('fuzz 首轮');
    expect(p1.status?.backgroundSeg).toContain('fuzz 首轮');
    const p2 = reduceSseEvent(s, ev('chat:subagent-finished', {
      taskId: 't1', description: 'fuzz 首轮', summary: '3 个独有崩溃', status: 'completed',
    }));
    const row = p2.appended.find((b) => b.kind === 'background');
    expect(row).toBeDefined();
    expect((row as Extract<Block, { kind: 'background' }>).summary).toContain('3 个独有崩溃');
    expect((row as Extract<Block, { kind: 'background' }>).switchHook).toBe(true);
    expect(s.tasks.get('t1')?.done).toBe(true);
  });

  it('chat:bg-started/finished → 状态段登记/移除 + 退出插行', () => {
    const s = makeSession();
    const p1 = reduceSseEvent(s, ev('chat:bg-started', { tag: 'fuzz-1', pid: 42, commandPreview: 'afl-fuzz -i in -o out' }));
    expect(s.bgProcs.get('fuzz-1')?.pid).toBe(42);
    expect(p1.status?.backgroundSeg).toContain('afl-fuzz');
    const p2 = reduceSseEvent(s, ev('chat:bg-finished', { tag: 'fuzz-1', status: 'exited', exitCode: 137 }));
    expect(s.bgProcs.has('fuzz-1')).toBe(false);
    const row = p2.appended.find((b) => b.kind === 'background');
    expect(row).toBeDefined();
    expect((row as Extract<Block, { kind: 'background' }>).summary).toContain('exit=137');
  });

  it('chat:boundary-ask → modal signal(含 askId);expired → modalExpired', () => {
    const s = makeSession();
    const p1 = reduceSseEvent(s, ev('chat:boundary-ask', {
      askId: 'ask-1', kind: 'host-write', objects: ['pwn-vm:/tmp/x', '→ 宿主 output/'],
    }));
    expect(p1.modal).toEqual({ kind: 'host-write', objects: ['pwn-vm:/tmp/x', '→ 宿主 output/'], askId: 'ask-1' });
    // 未知 kind 兜底 host-write(模态必须出,不能静默吞)。
    const p2 = reduceSseEvent(s, ev('chat:boundary-ask', { askId: 'ask-2', kind: 'mystery', objects: [] }));
    expect(p2.modal?.kind).toBe('host-write');
    const p3 = reduceSseEvent(s, ev('chat:boundary-expired', { askId: 'ask-1' }));
    expect(p3.modalExpired).toBe('ask-1');
  });

  it('dedupes replays by server message id across SSE reconnects', () => {
    // /chat/stream replays the FULL history on every (re)connect — without
    // id-dedupe the transcript double-prints after every reconnect.
    const s = replay([
      ev('chat:message-replay', { id: '0', role: 'user', content: 'q1' }),
      ev('chat:message-replay', { id: '1', role: 'assistant', content: 'a1' }),
      // --- reconnect: same history replayed again ---
      ev('chat:message-replay', { id: '0', role: 'user', content: 'q1' }),
      ev('chat:message-replay', { id: '1', role: 'assistant', content: 'a1' }),
      ev('chat:message-replay', { id: '2', role: 'user', content: 'q2' }),
    ]);
    expect(s.blocks.filter((b) => b.kind === 'user')).toHaveLength(2);
    expect(s.blocks.filter((b) => b.kind === 'assistant')).toHaveLength(1);
    // rewind needs the server id — it must survive on the block.
    const u = s.blocks.find((b) => b.kind === 'user') as UserBlock;
    expect(u.srvId).toBe('0');
  });

  it('renders a tool-use + tool-result-complete cycle into a folded tool block', () => {
    const s = replay([
      ev('chat:init', { sessionId: 's1', model: 'm', env: { id: 'host' } }),
      ev('chat:tool-use-start', { id: 'tool1', name: 'bash', summary: 'ls -la' }),
      ev('chat:tool-result-start', { id: 'tool1' }),
      ev('chat:tool-result-delta', { id: 'tool1', delta: 'line1\n' }),
      ev('chat:tool-result-delta', { id: 'tool1', delta: 'line2\n' }),
      ev('chat:tool-result-complete', { id: 'tool1', ok: true, exitCode: 0, elapsedMs: 120 }),
    ]);
    const tool = s.blocks.find((b) => b.kind === 'tool') as Extract<Block, { kind: 'tool' }>;
    expect(tool).toBeDefined();
    expect(tool.name).toBe('bash');
    expect(tool.state).toBe('done');
    expect(tool.exitCode).toBe(0);
    expect(tool.output).toBe('line1\nline2\n');
    expect(tool.folded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. blocks → TerminalWriter rendering (spans painted to a captured screen)
// ---------------------------------------------------------------------------

describe('blocks → TerminalWriter integration', () => {
  it('paints user + assistant + tool blocks to the screen sink', () => {
    const written: string[] = [];
    const sink = { write: (t: string) => { written.push(t); return true; } };
    const W = 60;
    const writer = new TerminalWriter({ out: sink, cols: W, rows: 24, inputHeight: 1 });

    const s = replay([
      ev('chat:init', { sessionId: 's1', model: 'm', env: { id: 'host' } }),
      ev('chat:message-chunk', { delta: 'The agent replied.' }),
      ev('chat:message-complete', {}),
    ]);
    // Inject a user + tool block to exercise all three renderers.
    s.blocks.unshift({ id: 'u1', kind: 'user', seq: 0, text: 'A user question' } as Block);
    s.blocks.push({
      id: 'tool1', kind: 'tool', seq: 99, name: 'bash', argsSummary: 'ls -la',
      state: 'done', exitCode: 0, folded: true,
    } as Block);

    writer.enter();
    writer.setChrome({ inputHeight: 1 });
    writer.setStatus([[{ text: 'idle' }]]);
    writer.setInput([[]]);

    for (const b of s.blocks) {
      let spans: Span[][] = [];
      if (b.kind === 'user') spans = renderUser(b as UserBlock, true);
      else if (b.kind === 'assistant') spans = renderAssistant(b as AssistantBlock, false, false);
      else if (b.kind === 'tool') spans = renderToolFolded(b as ToolBlock, W);
      for (const line of spans) writer.append(line);
    }
    writer.flush();

    const all = written.join('');
    expect(all).toContain('A user question');
    expect(all).toContain('The agent replied.');
    expect(all).toContain('bash');
    expect(all).toContain('ls -la');
  });
});

describe('gate logic (virtual admin client)', () => {
  function fakeAdminClient(handlers: Record<string, unknown>): SidecarClient {
    const fetchImpl: FetchLike = (async (url: string) => {
      const route = url.replace(/^https?:\/\/test\//, '');
      const body = (handlers[route] ?? { success: true }) as Record<string, unknown>;
      const res: FetchResponseLike = {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => 'application/json' },
        json: async () => body,
        text: async () => JSON.stringify(body),
        body: null,
      };
      return res;
    }) as FetchLike;
    return new SidecarClient({ base: 'http://test', fetchImpl });
  }

  it('buildGateOptions + moveGateCursor skip disabled recipes', () => {
    const opts: GateOption[] = buildGateOptions({
      environments: [{ id: 'vm1', kind: 'vm', user: 'u', host: 'h', container: 'c' }],
      instances: [],
      recipes: [
        { id: 'r_ok', name: 'ok', valid: true, base: 'docker' },
        { id: 'r_bad', name: 'bad', valid: false },
      ],
      dockerAvailable: false,
      dockerUnavailableReason: 'no docker',
      discovered: { docker: [], vm: [] },
    });
    expect(opts).toHaveLength(3); // one env + one valid recipe + manual:ssh
    expect(opts[1].disabled).toBe(true);
    expect(opts[2].key).toBe('manual:ssh'); // 手动接入永远可用(不进 commitGate)

    // From the env (index 0) pressing Down should skip the disabled recipe and
    // land on the manual option (then wrap back to 0).
    const cur = moveGateCursor(opts, 0, 1);
    expect(cur).toBe(2);
    expect(moveGateCursor(opts, 2, 1)).toBe(0);
  });

  it('commitGate selects a recipe and returns an env result', async () => {
    const client = fakeAdminClient({
      'api/admin/environment/up': { success: true, data: { instance: { name: 'vm_recipe' } } },
      'api/admin/environment/select': { success: true },
    });
    const spy = vi.spyOn(client, 'adminPost');
    const res = await commitGate(client, {
      group: 'recipe', key: 'recipe:r1', label: 'new', detail: '', disabled: false, recipeId: 'r1',
    }, '/ws');
    expect(res).toEqual({ kind: 'env', id: 'vm_recipe', warnings: [] });
    const called = spy.mock.calls.map((c) => String(c[0]));
    expect(called).toContain('environment/up');
    expect(called).toContain('environment/select');
    // environment/select must carry the workspace — the first cut dropped it
    // and selections silently never landed.
    const selCall = spy.mock.calls.find((c) => String(c[0]) === 'environment/select');
    expect((selCall?.[1] as { workspace?: string }).workspace).toBe('/ws');
  });

  it('commitGate on a stopped registered env selects + best-effort up (failure → warning, not hidden)', async () => {
    const client = fakeAdminClient({
      'api/admin/environment/select': { success: true },
      'api/admin/environment/up': { success: false, error: '未找到环境类型 "vm1"' },
    });
    const res = await commitGate(client, {
      group: 'stopped', key: 'env:vm1', label: 'vm1', detail: 'vm · vmware',
      disabled: false, envId: 'vm1', envKind: 'vmware',
    }, '/ws');
    expect(res.id).toBe('vm1');
    expect(res.warnings.length).toBe(1);
    expect(res.warnings[0]).toContain('未能自动拉起');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
