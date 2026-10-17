/**
 * refs 大值外溢消费端（1.6.3 debt #2，纯函数）。
 *
 * 写链路（src/server/sse.ts::dispatchWithSpillGuard + utils/large-value-store.ts）：
 *   SSE 事件 payload JSON >256KB → 落盘 ~/.zhishi/refs/<id>，线上事件名不变、
 *   payload 改发占位：
 *     { kind:'ref', id, sizeBytes, mimetype:'application/json',
 *       preview（head ≤8KB UTF-8）, expiresAt（默认 TTL 1h） }
 *   GET /refs/:id（sidecar 根路径，非 /api/admin）→ 200 流回原 payload 字节；
 *   缺失 / TTL 过期 / GC → 404 {error:'ref not found or expired'}；
 *   id 形状非法（非 8–32 位小写 hex）→ 400。
 *
 * 消费纪律（时序红线）：占位行先落流位置（appendRefPlaceholder），全文异步
 * 取回后按原事件名归约真 payload——tool-result-complete 等按 id 原位更新的
 * 事件天然不重排；最后 resolveRefPlaceholder('done') 摘除占位行。
 *
 * 本文件只放类型与纯函数——不 import store / React / client；I/O 装配见
 * store/useGuiStore.ts（handleRefPayload），HTTP 见 client/sse-client.ts::getRefText。
 */

import type { SessionState, RefItem } from './blocks';

// 2.0 audit D1：类型与守卫收敛到 shared（GUI/CLI 曾逐行副本）；本文件对外
// API 不变（re-export），消费方 import 路径零改动。
export type { LargeValueRef } from '../../../shared/ref-wire';
export { isLargeValueRef } from '../../../shared/ref-wire';
import type { LargeValueRef } from '../../../shared/ref-wire';

/** 人类可读体积（徽标文案用）：≥1MB 一位小数，否则整 KB。 */
export function formatRefSize(sizeBytes: number): string {
  if (sizeBytes >= 1024 * 1024) return `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
}

/** 占位行落流尾（事件到达位）。不可变更新，seq 与 pushItem 同口径 +1。 */
export function appendRefPlaceholder(
  session: SessionState,
  event: string,
  ref: LargeValueRef,
): SessionState {
  const item: RefItem = {
    kind: 'ref',
    id: `ref-${ref.id}`,
    seq: session.seq + 1,
    event,
    refId: ref.id,
    sizeBytes: ref.sizeBytes,
    preview: ref.preview,
    state: 'loading',
  };
  return { ...session, seq: session.seq + 1, items: [...session.items, item] };
}

/**
 * 占位行收尾：'done'（全文已归约）→ 摘除占位行（真事件 UI 已就位，不留
 * 残影）；'expired'（404，GC/TTL）/ 'failed'（传输错误）→ 留行降级展示
 * preview。找不到对应占位行 → 原样返回（引用相等，不触发重渲染）。
 */
export function resolveRefPlaceholder(
  session: SessionState,
  refId: string,
  outcome: 'done' | 'expired' | 'failed',
): SessionState {
  const id = `ref-${refId}`;
  if (!session.items.some((i) => i.kind === 'ref' && i.id === id)) return session;
  if (outcome === 'done') {
    return { ...session, items: session.items.filter((i) => !(i.kind === 'ref' && i.id === id)) };
  }
  return {
    ...session,
    items: session.items.map((i) => (i.kind === 'ref' && i.id === id ? { ...i, state: outcome } : i)),
  };
}
