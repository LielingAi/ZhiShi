/**
 * 越界 ask 的展示映射与登记表归约（1.3.1 ②，纯函数）。
 *
 * 服务端契约（src/server/loop/boundary-ask.ts）：
 *   - SSE `chat:boundary-ask` payload = { askId, kind, objects,
 *     toolName?, toolDescription?, options? }（1.3.2 起 additive 字段，
 *     展示文案由服务端随 payload 给出，GUI 不再只依赖 kind 本地映射；
 *     旧调用方不带时保持原形状，按 kind 映射兜底）。
 *     kind ∈ host-write | local-cred | net-policy | destroy-env
 *   - 应答端点 POST /chat/boundary/respond { askId, approve, note? }
 *     （1.3.2 起 note 被服务端消费并落盘进 transcript）。
 *   - 超时/作废：SSE `chat:boundary-expired` { askId }（收模态）。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface BoundaryAsk {
  askId: string;
  kind: string;
  objects: string[];
  /**
   * 1.3.2 任务二 #1：additive 字段（服务端随 payload 给出，有则显示）——
   * 触发工具名 / 工具说明 / 选项。旧调用方不带时保持缺省，展示由
   * BoundaryModal 按「有则显示」渲染。
   */
  toolName?: string;
  toolDescription?: string;
  options?: string[];
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
  view: { askId?: unknown; kind?: unknown; objects?: unknown; toolName?: unknown; toolDescription?: unknown; options?: unknown },
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
    // 1.3.2 任务二 #1：additive 字段透传（有则登记，展示时原样呈现）。
    ...(typeof view.toolName === 'string' && view.toolName ? { toolName: view.toolName } : {}),
    ...(typeof view.toolDescription === 'string' && view.toolDescription
      ? { toolDescription: view.toolDescription }
      : {}),
    ...(Array.isArray(view.options) && view.options.length > 0
      ? { options: view.options.filter((o): o is string => typeof o === 'string') }
      : {}),
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
