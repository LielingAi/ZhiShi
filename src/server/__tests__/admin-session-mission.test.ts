/**
 * 1.6.11 — session/mission 端点接线测试（会话线任务形态读/设）。
 *
 * 引擎用真实 defaultEngine（未初始化状态下线态读设是自洽的——lineMissions
 * 不依赖 agentDir）；afterEach 复位线态防串测试。
 *
 * 覆盖：读缺省 null；设合法值可读回；清除；非法值拒绝且不动现状。
 */
import { afterEach, describe, expect, it } from 'vitest';

import { handleSessionMission } from '../admin-api';
import { setPiLineMission } from '../loop/chat-engine';

afterEach(() => {
  setPiLineMission(undefined);
});

describe('handleSessionMission（1.6.11）', () => {
  it('缺省读 → null；设 discover → 读回 discover；null 清除', () => {
    expect((handleSessionMission({}).data as { mission: string | null }).mission).toBeNull();
    const r = handleSessionMission({ mission: 'discover' });
    expect(r.success).toBe(true);
    expect((handleSessionMission({}).data as { mission: string | null }).mission).toBe('discover');
    handleSessionMission({ mission: null });
    expect((handleSessionMission({}).data as { mission: string | null }).mission).toBeNull();
  });

  it('非法值 → 拒绝且不动现状', () => {
    setPiLineMission('reproduce');
    const r = handleSessionMission({ mission: 'hack' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('非法 mission');
    expect((handleSessionMission({}).data as { mission: string | null }).mission).toBe('reproduce');
  });
});
