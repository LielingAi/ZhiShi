/**
 * agent-session.ts 直接单元测试（debt #3）。
 *
 * 本文件是 M4c 裁留后的「配置面/元数据面」模块：模块级可变状态（active
 * session id / model / providerEnv / scenario / agent 定义）+ 少量函数
 * （initializeAgent / syncProjectUserConfig / withCronDispatchLock /
 * getHistoricalSessionMessages）。
 *
 * 与 SessionStore 相同的隔离策略：每个用例 mkdtemp + ZHISHI_DATA_DIR +
 * vi.resetModules() + 动态 import，拿到绑定临时目录的干净模块实例；
 * 不碰真实 ~/.zhishi。admin-config（工作区配置解析）用 vi.mock 隔离。
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionMessage } from './types/session';

// vi.hoisted：mock 工厂在 resetModules 后重跑时仍返回同一个 fn 实例，
// 这样每个用例都能重新 mockReturnValue 而不丢失引用。
const adminConfigMock = vi.hoisted(() => ({
  resolveWorkspaceConfig: vi.fn((): Record<string, unknown> => ({})),
}));

vi.mock('./utils/admin-config', () => adminConfigMock);

type AgentSession = typeof import('./agent-session');
type Store = typeof import('./SessionStore');

let dataDir: string;
let prevDataDir: string | undefined;
let agent: AgentSession;
let store: Store;

function makeMsg(id: string, role: 'user' | 'assistant' = 'user'): SessionMessage {
  return { id, role, content: `content-of-${id}`, timestamp: new Date().toISOString() };
}

beforeEach(async () => {
  prevDataDir = process.env.ZHISHI_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'agent-session-test-'));
  process.env.ZHISHI_DATA_DIR = dataDir;
  adminConfigMock.resolveWorkspaceConfig.mockReset().mockReturnValue({});
  vi.resetModules();
  agent = await import('./agent-session');
  store = await import('./SessionStore');
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  if (prevDataDir === undefined) delete process.env.ZHISHI_DATA_DIR;
  else process.env.ZHISHI_DATA_DIR = prevDataDir;
  delete process.env.ZHISHI_PORT;
});

describe('active session identity', () => {
  it('getSessionId/setActiveSessionId round-trip', () => {
    agent.setActiveSessionId('sess-1');
    expect(agent.getSessionId()).toBe('sess-1');
  });
});

describe('sidecar port', () => {
  it('setSidecarPort 写入模块状态与 ZHISHI_PORT 环境变量', () => {
    agent.setSidecarPort(4321);
    expect(agent.getSidecarPort()).toBe(4321);
    expect(process.env.ZHISHI_PORT).toBe('4321');
  });
});

describe('session model / scenario / agents 配置面状态', () => {
  it('setSessionModel → getSessionModel；初始 undefined', () => {
    expect(agent.getSessionModel()).toBeUndefined();
    agent.setSessionModel('k2-thinking');
    expect(agent.getSessionModel()).toBe('k2-thinking');
  });

  it('scenario set/get/reset：reset 回到 desktop', () => {
    expect(agent.getInteractionScenario()).toEqual({ type: 'desktop' });
    const cron = { type: 'cron', taskId: 't1', intervalMinutes: 5, aiCanExit: true } as const;
    agent.setInteractionScenario(cron);
    expect(agent.getInteractionScenario()).toEqual(cron);
    agent.resetInteractionScenario();
    expect(agent.getInteractionScenario()).toEqual({ type: 'desktop' });
  });

  it('setAgents/getAgents 进程内镜像', () => {
    expect(agent.getAgents()).toBeNull();
    const defs = { hunter: { description: 'd', prompt: 'p' } };
    agent.setAgents(defs);
    expect(agent.getAgents()).toEqual(defs);
  });
});

describe('initializeAgent（M4c 瘦版初始化）', () => {
  it('使用 initialSessionId 作为 active session；自解析 provider/model 镜像', async () => {
    adminConfigMock.resolveWorkspaceConfig.mockReturnValue({
      providerEnv: { baseUrl: 'https://provider.example' },
      model: 'model-x',
    });

    await agent.initializeAgent('E:/work/a', null, 'sess-init');

    expect(agent.getSessionId()).toBe('sess-init');
    expect(agent.getSessionModel()).toBe('model-x');
    expect(agent.getSessionProviderEnv()?.baseUrl).toBe('https://provider.example');
    expect(adminConfigMock.resolveWorkspaceConfig).toHaveBeenCalledWith('E:/work/a', null);
  });

  it('无 initialSessionId → 生成新 id；配置自解析失败不致命', async () => {
    adminConfigMock.resolveWorkspaceConfig.mockImplementation(() => {
      throw new Error('config broken');
    });

    await expect(agent.initializeAgent('E:/work/a')).resolves.toBeUndefined();
    expect(agent.getSessionId()).toBeTruthy();
  });
});

describe('withCronDispatchLock（cron 派发互斥锁）', () => {
  it('严格串行：后入者等待先入者完成', async () => {
    const trace: string[] = [];
    await Promise.all([
      agent.withCronDispatchLock(async () => {
        trace.push('A-enter');
        await new Promise(r => setTimeout(r, 30));
        trace.push('A-exit');
      }),
      agent.withCronDispatchLock(async () => {
        trace.push('B-enter');
        trace.push('B-exit');
      }),
    ]);
    expect(trace).toEqual(['A-enter', 'A-exit', 'B-enter', 'B-exit']);
  });

  it('前一次 fn reject 不毒化队列，后续照常执行', async () => {
    await expect(
      agent.withCronDispatchLock(async () => { throw new Error('tick failed'); }),
    ).rejects.toThrow('tick failed');

    const ran = await agent.withCronDispatchLock(async () => 'ok');
    expect(ran).toBe('ok');
  });
});

describe('getHistoricalSessionMessages（SessionStore backed 历史读取）', () => {
  it('按 offset/limit 切片并映射为 {type, uuid, session_id, message} 形状', async () => {
    const s = await store.createSession('E:/work/a');
    await store.saveSessionMessages(s.id, [
      makeMsg('m1'),
      makeMsg('m2', 'assistant'),
      makeMsg('m3'),
    ]);

    const page = await agent.getHistoricalSessionMessages(s.id, undefined, 2, 1);
    expect(page).toHaveLength(2);
    expect(page[0]).toEqual({
      type: 'assistant',
      uuid: 'm2',
      session_id: s.id,
      message: { role: 'assistant', content: 'content-of-m2' },
    });
    expect(page[1].uuid).toBe('m3');

    const full = await agent.getHistoricalSessionMessages(s.id);
    expect(full).toHaveLength(3);
  });

  it('未知 session → 空数组', async () => {
    expect(await agent.getHistoricalSessionMessages('nope')).toEqual([]);
  });
});

describe('syncProjectUserConfig（skills 软链同步）', () => {
  let projectDir: string;

  function makeUserSkill(name: string, withSkillMd = true): void {
    const dir = join(dataDir, 'skills', name);
    mkdirSync(dir, { recursive: true });
    if (withSkillMd) writeFileSync(join(dir, 'SKILL.md'), '# skill', 'utf-8');
  }

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'agent-session-project-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('有效 skill 链入 .claude/skills；无 SKILL.md 与 disabled 的不链', () => {
    makeUserSkill('good-skill');
    makeUserSkill('no-skillmd', false);
    makeUserSkill('disabled-skill');
    writeFileSync(join(dataDir, 'skills-config.json'), JSON.stringify({ disabled: ['disabled-skill'] }), 'utf-8');

    agent.syncProjectUserConfig(projectDir);

    const skillsDir = join(projectDir, '.claude', 'skills');
    expect(existsSync(join(skillsDir, 'good-skill', 'SKILL.md'))).toBe(true);
    expect(lstatSync(join(skillsDir, 'good-skill')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(skillsDir, 'no-skillmd'))).toBe(false);
    expect(existsSync(join(skillsDir, 'disabled-skill'))).toBe(false);
  });

  it('项目侧真实目录不被覆盖', () => {
    makeUserSkill('real-skill');
    const realDir = join(projectDir, '.claude', 'skills', 'real-skill');
    mkdirSync(realDir, { recursive: true });
    writeFileSync(join(realDir, 'marker.txt'), 'mine', 'utf-8');

    agent.syncProjectUserConfig(projectDir);

    expect(lstatSync(realDir).isSymbolicLink()).toBe(false);
    expect(existsSync(join(realDir, 'marker.txt'))).toBe(true);
  });

  it('用户 skill 删除后，残留软链在下次同步被清理', () => {
    makeUserSkill('vanish-skill');
    agent.syncProjectUserConfig(projectDir);
    const link = join(projectDir, '.claude', 'skills', 'vanish-skill');
    expect(existsSync(link)).toBe(true);

    rmSync(join(dataDir, 'skills', 'vanish-skill'), { recursive: true, force: true });
    agent.syncProjectUserConfig(projectDir);
    expect(existsSync(link)).toBe(false);
  });
});
