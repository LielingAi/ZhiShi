/**
 * S5 — `runCronExecuteSync` 编排函数（从 HTTP handler 抽出的一 tick 入口）。
 *
 * 为什么不去跑真 turn：一次 cron tick 是几十秒 + 要真 API key 的 agent turn。
 * 这里把"会话解析 / provider 解析 / 蒸馏短路 / 派发锁 / 工作区身份"这些**契约**
 * 用端口注入隔离出来锁死 —— 它们正是抽取时最容易漏掉、也最容易静默错的部分。
 *
 * 命名：放在 `.unit.test.ts`（spec 指定），但每个用例结束都复位 cron 上下文与
 * scenario 两个进程内全局，避免污染同 worker 的其它文件。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetInteractionScenario } from '../agent-session';
import { clearCronTaskContext } from '../tools/cron-tools';
import { runCronExecuteSync, type CronExecuteDeps } from './routes';
import type { SessionMetadata } from '../types/session';
import type { InteractionScenario } from '../system-prompt';

const ORIGINAL_DATA_DIR = process.env.ZHISHI_DATA_DIR;

/** sidecar 启动工作区（假）与任务工作区（假）——两个不同的真实目录。 */
let root: string;
let agentDir: string;
let taskWs: string;
let warns: string[];
let infos: string[];
let sessionCreates: Array<{ agentDir: string; snapshot?: Partial<SessionMetadata> }>;
let invokes: Array<{ input: { text: string; model?: string }; opts: { loopSessionId?: string; workspaceAnchor?: string; timeoutMs?: number; scenario?: InteractionScenario } }>;
let distillCalls: string[];
let researchDistillCalls: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'zhishi-cron-exec-'));
  agentDir = join(root, 'sidecar-start-ws');
  taskWs = join(root, 'task-ws');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(taskWs, { recursive: true });
  // 隔离配置读取（provider 解析走 <数据目录>/config.json），绝不碰真实 profile。
  process.env.ZHISHI_DATA_DIR = join(root, 'data');
  warns = [];
  infos = [];
  sessionCreates = [];
  invokes = [];
  distillCalls = [];
  researchDistillCalls = [];
});

afterEach(() => {
  clearCronTaskContext();
  resetInteractionScenario();
  rmSync(root, { recursive: true, force: true });
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.ZHISHI_DATA_DIR;
  else process.env.ZHISHI_DATA_DIR = ORIGINAL_DATA_DIR;
});

/** 造一套端口：默认全部"成功且不碰真引擎"。 */
function makeDeps(overrides: Partial<CronExecuteDeps> = {}): CronExecuteDeps {
  return {
    getAgentDir: () => agentDir,
    createSession: async (dir, snapshot) => {
      sessionCreates.push({ agentDir: dir, snapshot });
      return { id: snapshot?.id ?? 'minted-session', agentDir: dir } as SessionMetadata;
    },
    ensureMetaLoopLine: async (metaId) => `loop-${metaId}`,
    invokePiSession: (async (input: unknown, opts: unknown) => {
      invokes.push({
        input: input as { text: string; model?: string },
        opts: opts as { loopSessionId?: string; workspaceAnchor?: string; timeoutMs?: number },
      });
      return { text: '本轮输出', loopSessionId: (opts as { loopSessionId?: string })?.loopSessionId ?? 'loop-x' };
    }) as unknown as CronExecuteDeps['invokePiSession'],
    runDistillArc: async (opts) => {
      distillCalls.push(opts.workspacePath);
      return { status: 200, body: { success: true, outputText: 'distilled' } };
    },
    runResearchDistillArc: async (opts) => {
      researchDistillCalls.push(opts.workspacePath);
      return { status: 200, body: { success: true, outputText: 'research-distilled' } };
    },
    runWithArcLock: async <T>(fn: () => Promise<T>) => ({ ok: true as const, value: await fn() }),
    logger: {
      log: (...args: unknown[]) => infos.push(args.join(' ')),
      warn: (...args: unknown[]) => warns.push(args.join(' ')),
      error: () => {},
    },
    ...overrides,
  };
}

const basePayload = {
  taskId: 'task-1',
  prompt: '执行任务：做事',
  sessionId: 'sid-1',
  runMode: 'new_session' as const,
  get workspacePath(): string {
    return taskWs;
  },
};

describe('蒸馏弧哨兵短路（必须在开任何会话之前）', () => {
  it('认知蒸馏弧：直接走蒸馏管线，不创建会话、不 invoke', async () => {
    const result = await runCronExecuteSync(
      { ...basePayload, prompt: '<zhishi-distill-arc> 收集今天的会话' },
      makeDeps()
    );
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ success: true, outputText: 'distilled' });
    expect(sessionCreates).toHaveLength(0);
    expect(invokes).toHaveLength(0);
    // 蒸馏弧也吃到任务工作区（Rust 时代是本 tick 的 cwd）
    expect(distillCalls).toEqual([taskWs]);
  });

  it('安全蒸馏弧：同样短路', async () => {
    const result = await runCronExecuteSync(
      { ...basePayload, prompt: '<zhishi-research-distill> 结算研究事件' },
      makeDeps()
    );
    expect(result.body).toEqual({ success: true, outputText: 'research-distilled' });
    expect(sessionCreates).toHaveLength(0);
    expect(invokes).toHaveLength(0);
    expect(researchDistillCalls).toEqual([taskWs]);
  });

  it('弧锁被占 → 200 + skipped，不创建会话', async () => {
    const result = await runCronExecuteSync(
      { ...basePayload, prompt: '<zhishi-distill-arc> x' },
      makeDeps({ runWithArcLock: async () => ({ ok: false as const }) })
    );
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ success: true, skipped: 'arc-locked' });
    expect(sessionCreates).toHaveLength(0);
  });
});

describe('会话线解析', () => {
  it('new_session：新建会话（归属=任务工作区，id 用 payload 的），invoke 到新线', async () => {
    const result = await runCronExecuteSync({ ...basePayload, sessionId: 'rust-minted' }, makeDeps());

    expect(result.status).toBe(200);
    expect(sessionCreates).toHaveLength(1);
    // 会话归属目录必须是任务工作区，不是 sidecar 启动工作区
    expect(sessionCreates[0]!.agentDir).toBe(taskWs);
    // 新会话 id 沿用 payload（旧 Rust 预生成，防 Bug A 的双 id）
    expect(sessionCreates[0]!.snapshot?.id).toBe('rust-minted');
    expect(invokes[0]!.opts.loopSessionId).toBe('loop-rust-minted');
    expect(result.body.sessionId).toBe('rust-minted');
  });

  it('single_session：不新建会话，invoke 到存量会话的线', async () => {
    const result = await runCronExecuteSync(
      { ...basePayload, runMode: 'single_session', sessionId: 'existing-sid' },
      makeDeps()
    );
    expect(sessionCreates).toHaveLength(0);
    expect(invokes[0]!.opts.loopSessionId).toBe('loop-existing-sid');
    expect(result.body.sessionId).toBe('existing-sid');
  });

  it('ensureMetaLoopLine 失败（new_session）→ 500', async () => {
    const result = await runCronExecuteSync(basePayload, makeDeps({ ensureMetaLoopLine: async () => null }));
    expect(result.status).toBe(500);
    expect(result.body.error).toContain('Failed to create new session');
  });
});

describe('provider 解析', () => {
  it('providerId 解析失败 → 400 且错误串以 `Provider \'` 开头（调度器靠这个前缀转 blocked）', async () => {
    const result = await runCronExecuteSync(
      { ...basePayload, providerId: 'definitely-not-a-real-provider' },
      makeDeps()
    );
    expect(result.status).toBe(400);
    expect(String(result.body.error)).toMatch(/^Provider '/);
    // 失败即收尾：不 invoke
    expect(invokes).toHaveLength(0);
  });

  it('explicit 意图缺 providerEnv → 400（模型/端点会错配，fail closed）', async () => {
    const result = await runCronExecuteSync(
      { ...basePayload, providerIntent: 'explicit' },
      makeDeps()
    );
    expect(result.status).toBe(400);
    expect(result.body.error).toContain('providerEnv');
  });
});

describe('完成哨兵与响应形状', () => {
  it('CRON_TASK_COMPLETE 命中 → aiRequestedExit + exitReason，形状不变', async () => {
    const result = await runCronExecuteSync(
      basePayload,
      makeDeps({
        invokePiSession: (async (_input: unknown, opts: unknown) => {
          invokes.push({ input: { text: '' }, opts: opts as { loopSessionId?: string } });
          return { text: '做完了 [CRON_TASK_COMPLETE: 拿到 flag] 收工', loopSessionId: 'loop-x' };
        }) as unknown as CronExecuteDeps['invokePiSession'],
      })
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      success: true,
      aiRequestedExit: true,
      exitReason: '拿到 flag',
      sessionId: 'sid-1',
    });
    expect(result.body.outputText).toContain('收工');
  });

  it('invoke 报错 → 408（超时/引擎错误原样上抛）', async () => {
    const result = await runCronExecuteSync(
      basePayload,
      makeDeps({
        invokePiSession: (async () => ({ text: '', error: 'turn timeout', loopSessionId: 'l' })) as unknown as CronExecuteDeps['invokePiSession'],
      })
    );
    expect(result.status).toBe(408);
    expect(result.body).toEqual({ success: false, error: 'turn timeout' });
  });

  it('缺 taskId / prompt → 400', async () => {
    expect((await runCronExecuteSync({ taskId: '', prompt: 'x' }, makeDeps())).status).toBe(400);
    expect((await runCronExecuteSync({ taskId: 't', prompt: '' }, makeDeps())).status).toBe(400);
  });

  it('prompt 被包进 <system-reminder><CRON_TASK>', async () => {
    await runCronExecuteSync(basePayload, makeDeps());
    expect(invokes[0]!.input.text).toBe(
      '<system-reminder>\n<CRON_TASK>\n执行任务：做事\n</CRON_TASK>\n</system-reminder>'
    );
    // 超时仍是 1 小时（Rust 同名常量）
    expect(invokes[0]!.opts.timeoutMs).toBe(3_600_000);
  });
});

describe('工作区身份（S5 的核心修复）', () => {
  it('给了不同的任务工作区 → 会话归属 / research_log 锚 / 日志都用它', async () => {
    await runCronExecuteSync({ ...basePayload, workspacePath: taskWs }, makeDeps());

    expect(sessionCreates[0]!.agentDir).toBe(taskWs);
    // research_log 事件归属锚（缺了会让 A 工程任务把档案戳到 B 工程）
    expect(invokes[0]!.opts.workspaceAnchor).toBe(taskWs);
    expect(infos.some((line) => line.includes('本 tick 使用任务工作区') && line.includes(taskWs))).toBe(true);
  });

  it('workspacePath 为空 → 回落 sidecar 启动工作区并 warn', async () => {
    await runCronExecuteSync({ ...basePayload, workspacePath: '' }, makeDeps());

    expect(sessionCreates[0]!.agentDir).toBe(agentDir);
    expect(invokes[0]!.opts.workspaceAnchor).toBe(agentDir);
    expect(warns.some((line) => line.includes('任务未声明工作区') && line.includes(agentDir))).toBe(true);
  });

  it('workspacePath 目录不存在 → 回落并 warn', async () => {
    const missing = join(root, 'nope-ws');
    await runCronExecuteSync({ ...basePayload, workspacePath: missing }, makeDeps());

    expect(sessionCreates[0]!.agentDir).toBe(agentDir);
    expect(warns.some((line) => line.includes('任务工作区不存在'))).toBe(true);
  });

  it('任务工作区 == 启动工作区 → 不刷 info（避免每 tick 一行噪音）', async () => {
    await runCronExecuteSync({ ...basePayload, workspacePath: agentDir }, makeDeps());
    expect(infos.some((line) => line.includes('本 tick 使用任务工作区'))).toBe(false);
  });
});

describe('派发锁（withCronDispatchLock）', () => {
  it('两个并发 tick 严格串行（session/scenario/上下文是进程级共享状态）', async () => {
    let active = 0;
    let maxActive = 0;
    const deps = makeDeps({
      invokePiSession: (async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return { text: 'ok', loopSessionId: 'l' };
      }) as unknown as CronExecuteDeps['invokePiSession'],
    });

    const [a, b] = await Promise.all([
      runCronExecuteSync({ ...basePayload, taskId: 'task-a' }, deps),
      runCronExecuteSync({ ...basePayload, taskId: 'task-b' }, deps),
    ]);

    expect(maxActive).toBe(1);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
});
