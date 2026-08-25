/**
 * 越界 ask 的展示映射与登记表归约（1.3.1 ②，纯函数）。
 *
 * 服务端契约（src/server/loop/boundary-ask.ts）：
 *   - SSE `chat:boundary-ask` payload = { askId, kind, objects }
 *     kind ∈ host-write | local-cred | net-policy | destroy-env
 *   - 应答端点 POST /chat/boundary/respond { askId, approve }
 *     （respondBoundaryAsk 只消费 approve；本 UI 附带 note 为 additive
 *       字段，服务端忽略——见交付报告「服务端缺口清单」。）
 *   - 超时/作废：SSE `chat:boundary-expired` { askId }（收模态）。
 *
 * 服务端 payload 里没有工具名/说明/选项字段（设计稿 §6.6 的模态草案
 * 与实现形状有出入）——工具名等展示文案由 kind 映射表本地生成。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 服务端 BoundaryAskView 的 kind 枚举。 */
export type BoundaryAskKind = 'host-write' | 'local-cred' | 'net-policy' | 'destroy-env';

export interface BoundaryAsk {
  askId: string;
  kind: string;
  objects: string[];
  /** GUI 本地登记时间（排序/展示用）。 */
  receivedAt: number;
}

export interface BoundaryKindMeta {
  /** 模态标题动作（如「写入宿主文件系统」）。 */
  title: string;
  /** 说明文案（人该怎么判断）。 */
  desc: string;
  /** 批准按钮文案。 */
  approveLabel: string;
  /** 拒绝按钮文案。 */
  denyLabel: string;
}

// ---------------------------------------------------------------------------
// kind → 文案映射
// ---------------------------------------------------------------------------

export const BOUNDARY_KIND_META: Record<string, BoundaryKindMeta> = {
  'host-write': {
    title: '写入宿主文件系统',
    desc: '环境内成果要落回宿主（提取文件 / 导出报告）。确认对象可信后再批准。',
    approveLabel: '批准写入',
    denyLabel: '拒绝',
  },
  'local-cred': {
    title: '使用本机凭据',
    desc: '动作需要读取本机凭据（SSH 密钥 / 令牌引用）。每次越界都重新问。',
    approveLabel: '批准使用',
    denyLabel: '拒绝',
  },
  'net-policy': {
    title: '修改网络策略',
    desc: '动作会改动网络策略（代理 / 防火墙 / 路由）。确认影响范围后再批准。',
    approveLabel: '批准修改',
    denyLabel: '拒绝',
  },
  'destroy-env': {
    title: '销毁有成果环境',
    desc: '目标环境有未回收成果。销毁不可逆——请确认成果已提取。',
    approveLabel: '批准销毁',
    denyLabel: '拒绝',
  },
};

/** 未知 kind 的兜底文案（前向兼容服务端新增 kind）。 */
const FALLBACK_META: BoundaryKindMeta = {
  title: '越界动作待批准',
  desc: '该动作超出当前边界，需要人批准。',
  approveLabel: '批准',
  denyLabel: '拒绝',
};

export function boundaryAskMeta(kind: string): BoundaryKindMeta {
  return BOUNDARY_KIND_META[kind] ?? FALLBACK_META;
}

// ---------------------------------------------------------------------------
// 登记表归约（chat:boundary-ask / chat:boundary-expired / 本地应答）
// ---------------------------------------------------------------------------

/** chat:boundary-ask payload → 登记条目（幂等 upsert，按 askId）。 */
export function upsertBoundaryAsk(
  asks: BoundaryAsk[],
  view: { askId?: unknown; kind?: unknown; objects?: unknown },
  receivedAt = Date.now(),
): BoundaryAsk[] {
  const askId = typeof view.askId === 'string' ? view.askId : '';
  if (!askId) return asks;
  const entry: BoundaryAsk = {
    askId,
    kind: typeof view.kind === 'string' ? view.kind : '',
    objects: Array.isArray(view.objects)
      ? view.objects.filter((o): o is string => typeof o === 'string')
      : [],
    receivedAt,
  };
  const existing = asks.find((a) => a.askId === askId);
  if (existing) return asks.map((a) => (a.askId === askId ? entry : a));
  return [...asks, entry];
}

/** chat:boundary-expired / 本地应答成功后移除。 */
export function removeBoundaryAsk(asks: BoundaryAsk[], askId: unknown): BoundaryAsk[] {
  if (typeof askId !== 'string' || !askId) return asks;
  return asks.filter((a) => a.askId !== askId);
}

/** 待答列表是否包含某 askId（应答幂等守卫）。 */
export function hasBoundaryAsk(asks: BoundaryAsk[], askId: unknown): boolean {
  return typeof askId === 'string' && asks.some((a) => a.askId === askId);
}
