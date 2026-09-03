/**
 * refs 大值外溢消费端（CLI 侧，1.6.3 debt #2）。
 *
 * 背景（写链路见 src/server/sse.ts::dispatchWithSpillGuard +
 * utils/large-value-store.ts）：SSE 事件 payload JSON >256KB 时服务端落盘
 * ~/.zhishi/refs/<id>，线上改发占位：
 *   { kind:'ref', id, sizeBytes, mimetype, preview（head ≤8KB）, expiresAt（TTL 1h） }
 * 全量体走 GET /refs/:id（sidecar 根路径，非 /api/admin）：
 *   200 → 原 payload 字节（外溢的是事件 payload 的 JSON 文本）；
 *   404 → {error:'ref not found or expired'}（缺失 / TTL 过期 / GC 已回收）；
 *   400 → id 形状非法（非 8–32 位小写 hex）。
 *
 * CLI 不消费 SSE（admin API 包装器），消费形态 = 两件事：
 *   ① printResult 深扫响应——发现 {kind:'ref'} 占位就在 stderr 打取回指引
 *     （stdout 留给数据/json 管线），不让用户对着占位符干瞪眼；
 *   ② `zhishi refs get <id>`——按需取回全文打印（本文件的 fetchRefBody）。
 *
 * 纯函数 + 可注入 fetch——单测不碰真实网络（ref.unit.test.ts）。
 */

/** 服务端 LargeValueRef 形状镜像（large-value-store.ts）。 */
export interface LargeValueRef {
  kind: 'ref';
  id: string;
  sizeBytes: number;
  mimetype: string;
  preview: string;
  expiresAt: number;
}

const REF_ID_RE = /^[a-f0-9]{8,32}$/;

/** /refs/:id 路由同口径 id 校验（8–32 位小写 hex）。 */
export function isValidRefId(id: string): boolean {
  return REF_ID_RE.test(id);
}

/** `{kind:'ref'}` 占位识别（字段齐全 + id 过路由正则才算）。 */
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

const COLLECT_MAX_DEPTH = 8;

/**
 * 深扫 JSON 值里的全部 ref 占位（对象/数组递归，按 id 去重，深度封顶 8 层
 * 防畸形嵌套）。用于 printResult 的取回指引。
 */
export function collectRefs(value: unknown, depth = 0): LargeValueRef[] {
  const out: LargeValueRef[] = [];
  const seen = new Set<string>();
  const walk = (v: unknown, d: number): void => {
    if (d > COLLECT_MAX_DEPTH || !v || typeof v !== 'object') return;
    if (isLargeValueRef(v)) {
      if (!seen.has(v.id)) {
        seen.add(v.id);
        out.push(v);
      }
      return; // ref 叶子——preview 是文本，不再下钻
    }
    if (Array.isArray(v)) {
      for (const item of v) walk(item, d + 1);
      return;
    }
    for (const item of Object.values(v as Record<string, unknown>)) walk(item, d + 1);
  };
  walk(value, depth);
  return out;
}

function formatSize(sizeBytes: number): string {
  if (sizeBytes >= 1024 * 1024) return `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
}

/** 取回指引行（照 recoveryHint 的 `→ Run:` 惯例，printResult 打 stderr）。 */
export function formatRefHints(refs: LargeValueRef[]): string[] {
  return refs.map(
    (r) =>
      `→ 响应含大 payload 外溢占位 ref=${r.id}（${formatSize(r.sizeBytes)}，${r.mimetype}）` +
      `——全文：zhishi refs get ${r.id}`,
  );
}

// ---------------------------------------------------------------------------
// GET /refs/:id（fetch 可注入）
// ---------------------------------------------------------------------------

export interface RefFetchResponse {
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type RefFetch = (
  url: string,
  init?: { method?: string; dispatcher?: unknown },
) => Promise<RefFetchResponse>;

export type RefFetchResult =
  | { ok: true; body: string; contentType: string }
  /** status=0 表示传输层失败（未拿到响应）。 */
  | { ok: false; status: number; error: string };

/**
 * 取回外溢全文。id 先过路由同口径校验（非法 id 不发请求，直接 400 语义）；
 * 404 → {error:'ref not found or expired'} 由调用方翻成人话（GC 降级）。
 */
export async function fetchRefBody(
  base: string,
  id: string,
  fetchImpl: RefFetch,
  dispatcher?: unknown,
): Promise<RefFetchResult> {
  if (!isValidRefId(id)) {
    return { ok: false, status: 400, error: `invalid ref id "${id}"` };
  }
  const root = base.replace(/\/+$/, '');
  let res: RefFetchResponse;
  try {
    res = await fetchImpl(`${root}/refs/${encodeURIComponent(id)}`, {
      method: 'GET',
      dispatcher,
    });
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
  if (res.status === 404) {
    return { ok: false, status: 404, error: 'ref not found or expired' };
  }
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, status: res.status, error: `HTTP ${res.status} ${res.statusText}` };
  }
  return {
    ok: true,
    body: await res.text(),
    contentType: res.headers.get('content-type') ?? '',
  };
}
