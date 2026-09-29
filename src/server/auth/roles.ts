/**
 * 1.8.7 P1 团队大脑——角色三档 + 全量路由角色分类表（设计稿 R1 的逐条分类，
 * 本文件即交付物；验收门槛「路由角色分类表全量过一遍」以此为准）。
 *
 * 角色（随 token 下发，严格递增）：
 *   readonly  只读——档案/claims/进度/知识/SSE 订阅；
 *   operator  操作员——+ 环境生命周期、实体推进（resolve）、认领、聊天
 *             send/stop/reset、会话操作、任务写、情报更新、蒸馏、config/set；
 *   reviewer  审定人——+ 纠正（correct）、放弃（abandon）、专家审定
 *             （add/update/rm/review）、模型 key 管理、boundary/决策审批、
 *             auth 管理面本身。
 *
 * 分类纪律：
 * - 拿不准一律从紧（选更高档），并在该行的注释里点名；
 * - DEFAULT_ADMIN_ROLE / DEFAULT_ROLE = reviewer——未分类即最高档，
 *   新路由忘记登记时 fail closed（多数人用不了）而不是 fail open；
 * - 开放路由只有 GET /health 与 GET /health/ready（Rust spawn 探活 +
 *   CLI/GUI 连接前探测依赖它们零鉴权可用）。
 */

export type AuthRole = 'readonly' | 'operator' | 'reviewer';

export const AUTH_ROLES: readonly AuthRole[] = ['readonly', 'operator', 'reviewer'];

export function isAuthRole(value: string): value is AuthRole {
  return (AUTH_ROLES as readonly string[]).includes(value);
}

const ROLE_RANK: Record<AuthRole, number> = { readonly: 1, operator: 2, reviewer: 3 };

/** have 是否达到 need（readonly < operator < reviewer）。 */
export function roleAtLeast(have: AuthRole, need: AuthRole): boolean {
  return ROLE_RANK[have] >= ROLE_RANK[need];
}

// ---------------------------------------------------------------------------
// Admin 路由分类表（POST /api/admin/<route>）——与 index.ts routeAdminApi
// 的分派逐条对齐；新增 admin 路由必须在此登记，否则按 DEFAULT_ADMIN_ROLE
// = reviewer 处理。
// ---------------------------------------------------------------------------

export const ADMIN_ROUTE_ROLE: Record<string, AuthRole> = {
  // ── 模型：读=只读；增删/key/默认=审定人（key 是凭据管理面）──
  'model/list': 'readonly',
  'model/add': 'reviewer',
  'model/remove': 'reviewer',
  'model/set-key': 'reviewer',
  'model/set-default': 'reviewer',
  'model/verify': 'readonly', // 用已存 key 探活供应商，无状态变更
  // ── 子代理：读=只读；启停/设置=操作员 ──
  'agent/list': 'readonly',
  'agent/show': 'readonly',
  'agent/enable': 'operator',
  'agent/disable': 'operator',
  'agent/set': 'operator',
  // ── 环境：探测/列表=只读；生命周期/执行/传输=操作员 ──
  'environment/engines': 'readonly',
  'environment/list': 'readonly',
  'environment/add': 'operator',
  'environment/open': 'operator',
  'environment/recipes': 'readonly',
  'environment/up': 'operator',
  'environment/down': 'operator',
  'environment/rebuild': 'operator',
  'environment/reset': 'operator',
  'environment/ps': 'readonly',
  'environment/discover': 'readonly',
  'environment/image-remove': 'operator', // docker rmi——破坏性的环境生命周期
  'environment/capability-refresh': 'operator',
  'environment/bind-recipes': 'operator',
  'environment/adopt': 'operator',
  'environment/setup': 'operator',
  'environment/install': 'operator',
  'environment/build': 'operator',
  'environment/rm': 'operator',
  'environment/rename': 'operator',
  'environment/exec': 'operator',
  'environment/snapshot': 'operator',
  'environment/rollback': 'operator',
  'environment/extract': 'operator',
  'environment/push': 'operator',
  'environment/select': 'operator', // 写 env-selection.json
  'environment/current': 'readonly',
  'environment/term': 'operator', // WS upgrade 端点（实际过 term-pty 的闸，此处防御性登记）
  // ── 域包清单：只读 ──
  'domain/list': 'readonly',
  'domain/check': 'readonly',
  // ── 研究档案 / claims ──
  'archive/list': 'readonly',
  'archive/correct': 'reviewer', // 纠正=审定人（设计稿角色表）
  'archive/resolve': 'operator', // 实体推进=操作员
  'archive/abandon': 'reviewer', // 放弃=审定人（从紧）
  'archive/op': 'reviewer', // 从紧：桥接投影面兼具档案写与 claims 写，取更高档
  'claims/read': 'readonly',
  'claim/list': 'readonly',
  'claim/forget': 'operator',
  // ── 报告导出：组装+落盘报告文件，按设计稿「export=只读」口径 ──
  'report/export': 'readonly',
  // ── auto-run / 战役 ──
  'auto-run/start': 'operator',
  'auto-run/stop': 'operator',
  'auto-run/list': 'readonly',
  'auto-run/clear': 'operator',
  'campaign/list': 'readonly',
  'campaign/stop': 'operator',
  'campaign/resume': 'operator',
  'session/mission': 'operator',
  // ── 文档/help ──
  'readme/widget': 'readonly',
  'help': 'readonly',
  // ── 记忆：读=只读；反馈/写入=操作员 ──
  'memory/active-reminders': 'readonly',
  'memory/reminder-feedback': 'operator',
  'memory/search': 'readonly',
  'memory/overview': 'readonly',
  // ── 研究信号 / 蒸馏 ──
  'research/log': 'operator',
  'research/list': 'readonly',
  'research/distilled': 'readonly',
  'distill/run': 'operator',
  // ── 情报 ──
  'intel/update': 'operator',
  'intel/status': 'readonly',
  'intel/config-update': 'operator',
  'intel/search': 'readonly',
  // ── 专家知识层：读=只读；管理/审定=审定人 ──
  'expert/search': 'readonly',
  'expert/list': 'readonly',
  'expert/show': 'readonly',
  'expert/add': 'reviewer',
  'expert/update': 'reviewer',
  'expert/rm': 'reviewer',
  'expert/drafts': 'readonly',
  'expert/review': 'reviewer',
  'expert/promote-prefill': 'reviewer', // 从紧：promote 流程的预填步骤
  // ── term 面板代理（Rust 终端管理面；write/open/close=操作员，read/list=只读）──
  'term/open': 'operator',
  'term/write': 'operator',
  'term/read': 'readonly',
  'term/list': 'readonly',
  'term/close': 'operator',
  // ── persona：已退役（路由只回错误），登记只读兜底 ──
  'persona/read': 'readonly',
  'persona/write': 'readonly',
  // ── 信任账本 ──
  'trust/event': 'operator',
  'trust/ledger': 'readonly',
  'trust/resolve': 'reviewer', // 从紧：裁决语义
  'trust/reset': 'reviewer', // 从紧：整账重置是破坏性权限动作
  'trust/import': 'reviewer', // 从紧：整账导入覆盖
  // ── 配置：get 已做 key 脱敏=只读；set=操作员（auth 键在 set 侧另有限制）──
  'config/get': 'readonly',
  'config/set': 'operator',
  // ── 任务中心：读=只读；写/运行=操作员 ──
  'task/list': 'readonly',
  'task/get': 'readonly',
  'task/read-doc': 'readonly',
  'task/create-direct': 'operator',
  'task/create-from-alignment': 'operator',
  'task/run': 'operator',
  'task/rerun': 'operator',
  'task/update': 'operator',
  'task/update-status': 'operator',
  'task/append-session': 'operator',
  'task/archive': 'operator',
  'task/delete': 'operator',
  'task/write-doc': 'operator',
  // ── 系统 ──
  'status': 'readonly',
  'version': 'readonly',
  'reload': 'operator', // 触发重扫，状态变更
  // ── auth 管理面：审定人专属（disable 防锁死就靠这条 + HTTP 闸）──
  'auth/list': 'reviewer',
  'auth/add': 'reviewer',
  'auth/revoke': 'reviewer',
  'auth/enable': 'reviewer',
  'auth/disable': 'reviewer',
};

/** 未登记的 admin 路由一律按最高档（fail closed）。 */
export const DEFAULT_ADMIN_ROLE: AuthRole = 'reviewer';

// ---------------------------------------------------------------------------
// 非 admin 路由分类（method + path 规则，顺序敏感：精确规则在前缀规则之前）
// ---------------------------------------------------------------------------

export type RouteAccess = AuthRole | 'open';

/** 非 admin 路由的兜底——同样 fail closed。 */
export const DEFAULT_ROLE: AuthRole = 'reviewer';

/** 聊天/会话/cron 等写操作（operator）。 */
const NON_ADMIN_OPERATOR_POSTS = new Set([
  '/health/ready/retry', // 触发 deferred init 重跑=状态变更
  '/chat/send',
  '/chat/model',
  '/chat/stop',
  '/chat/rewind',
  '/chat/queue/cancel',
  '/chat/reset',
  '/sessions/fork',
  '/sessions/switch',
  '/cron/execute-sync',
]);

/** 审批/裁决应答（reviewer——设计稿角色表「审批 boundary ask=审定人」）。 */
const NON_ADMIN_REVIEWER_POSTS = new Set([
  '/chat/boundary/respond',
  '/chat/decision/respond', // 从紧：决策审批与 boundary 审批同级
]);

/**
 * 路由 → 所需角色。'open' = 零鉴权（仅 GET /health 与 GET /health/ready，
 * Rust spawn 探活与 CLI/GUI 连接前探测依赖）。
 */
export function requiredRoleFor(pathname: string, method: string): RouteAccess {
  const m = method.toUpperCase();
  if (m === 'GET' && (pathname === '/health' || pathname === '/health/ready')) return 'open';
  if (pathname.startsWith('/api/admin/')) {
    const route = pathname.slice('/api/admin/'.length);
    return ADMIN_ROUTE_ROLE[route] ?? DEFAULT_ADMIN_ROLE;
  }
  if (m === 'POST' && NON_ADMIN_OPERATOR_POSTS.has(pathname)) return 'operator';
  if (m === 'POST' && NON_ADMIN_REVIEWER_POSTS.has(pathname)) return 'reviewer';
  if (m === 'GET' && pathname.startsWith('/refs/')) return 'readonly';
  if (m === 'GET' && pathname === '/api/session-state') return 'readonly';
  if (m === 'GET' && pathname === '/api/loop-session/messages') return 'readonly';
  if (m === 'GET' && pathname === '/chat/stream') return 'readonly'; // SSE 订阅=只读档
  if (m === 'GET' && pathname === '/chat/queue/status') return 'readonly';
  if (m === 'GET' && pathname === '/sessions') return 'readonly';
  if (pathname.startsWith('/sessions/')) {
    if (m === 'GET') return 'readonly';
    if (m === 'DELETE' || m === 'PATCH') return 'operator';
  }
  if (m === 'GET' && pathname === '/api/workspace/files') return 'readonly';
  if (m === 'GET' && pathname === '/api/agents') return 'readonly';
  // placeholder 占位页（serveStatic 只服务它）——只读可见
  if (m === 'GET' && (pathname === '/' || pathname === '/index.html')) return 'readonly';
  return DEFAULT_ROLE;
}
