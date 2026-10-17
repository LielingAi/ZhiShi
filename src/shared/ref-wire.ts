/**
 * refs 大值外溢——线协议的单一事实源（2.0 audit D1：GUI/CLI 逐行副本收敛）。
 *
 * 写链路（src/server/sse.ts::dispatchWithSpillGuard +
 * utils/large-value-store.ts）：SSE 事件 payload JSON >256KB → 落盘
 * ~/.zhishi/refs/<id>，线上事件名不变、payload 改发占位：
 *   { kind:'ref', id, sizeBytes, mimetype:'application/json',
 *     preview（head ≤8KB UTF-8）, expiresAt（默认 TTL 1h） }
 * GET /refs/:id → 200 流回原字节；404 缺失/过期；400 id 形状非法。
 *
 * 纯类型 + 纯函数（不 import 任何端侧模块）。消费端：
 * gui model/ref.ts、cli ref.ts 从这里 re-export——守卫口径改一处两端生效。
 */

/** 服务端 LargeValueRef 形状镜像（utils/large-value-store.ts）。 */
export interface LargeValueRef {
  kind: 'ref';
  /** 8–32 位小写 hex（uuid 首段；/refs/:id 路由同口径校验）。 */
  id: string;
  sizeBytes: number;
  mimetype: string;
  preview: string;
  expiresAt: number;
}

/** /refs/:id 路由同口径 id 校验（8–32 位小写 hex）。 */
export const REF_ID_RE = /^[a-f0-9]{8,32}$/;

export function isValidRefId(id: string): boolean {
  return REF_ID_RE.test(id);
}

/**
 * `{kind:'ref'}` 占位识别。id 必须过路由同口径正则——否则取回必 400，
 * 按非占位处理（让原归约兜底，不制造必失败的取回）。
 * 字段集与迁移前两端实现逐字一致（不校验 mimetype——历史实现即如此，
 * 收紧会把缺失该字段的旧 payload 从 ref 通道误踢回普通归约）。
 */
export function isLargeValueRef(v: unknown): v is LargeValueRef {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const p = v as Record<string, unknown>;
  return (
    p.kind === 'ref' &&
    typeof p.id === 'string' &&
    REF_ID_RE.test(p.id) &&
    typeof p.sizeBytes === 'number' &&
    typeof p.preview === 'string' &&
    typeof p.expiresAt === 'number'
  );
}
