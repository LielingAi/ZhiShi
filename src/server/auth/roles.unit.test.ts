/**
 * roles 单测（1.8.7 P1）：角色三档序 + 路由分类表的代表性断言。
 *
 * 分类表本身是交付物——这里不逐条复读，只钉死：开放面、每档一条代表路由、
 * 兜底 fail-closed、method 敏感的前缀规则。
 */
import { describe, expect, it } from 'vitest';

import {
  ADMIN_ROUTE_ROLE,
  DEFAULT_ADMIN_ROLE,
  DEFAULT_ROLE,
  isAuthRole,
  requiredRoleFor,
  roleAtLeast,
} from './roles';

describe('角色序', () => {
  it('readonly < operator < reviewer', () => {
    expect(roleAtLeast('readonly', 'readonly')).toBe(true);
    expect(roleAtLeast('operator', 'readonly')).toBe(true);
    expect(roleAtLeast('reviewer', 'operator')).toBe(true);
    expect(roleAtLeast('readonly', 'operator')).toBe(false);
    expect(roleAtLeast('operator', 'reviewer')).toBe(false);
  });

  it('isAuthRole 只认三档', () => {
    expect(isAuthRole('readonly')).toBe(true);
    expect(isAuthRole('operator')).toBe(true);
    expect(isAuthRole('reviewer')).toBe(true);
    expect(isAuthRole('admin')).toBe(false);
    expect(isAuthRole('')).toBe(false);
  });
});

describe('开放路由（零鉴权）', () => {
  it('GET /health 与 GET /health/ready 开放，其余 method 不开放', () => {
    expect(requiredRoleFor('/health', 'GET')).toBe('open');
    expect(requiredRoleFor('/health/ready', 'GET')).toBe('open');
    expect(requiredRoleFor('/health', 'POST')).not.toBe('open');
  });
});

describe('admin 路由分类（每档代表）', () => {
  it('只读档', () => {
    for (const r of ['model/list', 'environment/list', 'environment/ps', 'archive/list', 'expert/show', 'config/get', 'task/list', 'status', 'claims/read']) {
      expect(requiredRoleFor(`/api/admin/${r}`, 'POST'), r).toBe('readonly');
    }
  });

  it('操作员档', () => {
    for (const r of ['environment/up', 'environment/exec', 'archive/resolve', 'config/set', 'task/run', 'auto-run/start', 'claim/forget', 'distill/run', 'intel/update']) {
      expect(requiredRoleFor(`/api/admin/${r}`, 'POST'), r).toBe('operator');
    }
  });

  it('审定人档', () => {
    for (const r of ['archive/correct', 'archive/abandon', 'expert/add', 'expert/review', 'model/set-key', 'model/add', 'auth/list', 'auth/add', 'auth/revoke', 'auth/enable', 'auth/disable']) {
      expect(requiredRoleFor(`/api/admin/${r}`, 'POST'), r).toBe('reviewer');
    }
  });

  it('未登记的 admin 路由 → DEFAULT_ADMIN_ROLE（fail closed）', () => {
    expect(DEFAULT_ADMIN_ROLE).toBe('reviewer');
    expect(requiredRoleFor('/api/admin/some/future-route', 'POST')).toBe('reviewer');
  });

  it('term WS 端点按 operator 登记', () => {
    expect(ADMIN_ROUTE_ROLE['environment/term']).toBe('operator');
  });
});

describe('非 admin 路由分类', () => {
  it('SSE 订阅与会话读 = 只读档', () => {
    expect(requiredRoleFor('/chat/stream', 'GET')).toBe('readonly');
    expect(requiredRoleFor('/sessions', 'GET')).toBe('readonly');
    expect(requiredRoleFor('/sessions/abc', 'GET')).toBe('readonly');
    expect(requiredRoleFor('/chat/queue/status', 'GET')).toBe('readonly');
    expect(requiredRoleFor('/refs/ab12cd34', 'GET')).toBe('readonly');
  });

  it('聊天/会话写 = 操作员档', () => {
    for (const p of ['/chat/send', '/chat/stop', '/chat/reset', '/chat/model', '/sessions/switch', '/sessions/fork', '/cron/execute-sync']) {
      expect(requiredRoleFor(p, 'POST'), p).toBe('operator');
    }
    expect(requiredRoleFor('/sessions/abc', 'DELETE')).toBe('operator');
    expect(requiredRoleFor('/sessions/abc', 'PATCH')).toBe('operator');
  });

  it('boundary/决策审批 = 审定人档', () => {
    expect(requiredRoleFor('/chat/boundary/respond', 'POST')).toBe('reviewer');
    expect(requiredRoleFor('/chat/decision/respond', 'POST')).toBe('reviewer');
  });

  it('method 不匹配时不命中规则（GET /chat/send → 兜底）', () => {
    expect(requiredRoleFor('/chat/send', 'GET')).toBe(DEFAULT_ROLE);
  });

  it('未知路径 → DEFAULT_ROLE（fail closed）', () => {
    expect(DEFAULT_ROLE).toBe('reviewer');
    expect(requiredRoleFor('/nope', 'GET')).toBe('reviewer');
  });
});
