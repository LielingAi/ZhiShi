/**
 * 1.4.7 — 研究档案 admin handler（god file 绞杀续拆）：从 admin-api.ts 抽出
 * 的 archive/list + archive/correct 两个 handler。纯搬移、行为零变化；
 * admin-api.ts re-export 保持既有调用点（index.ts routeAdminApi）不动。
 */

import { correctEntity, loadArchive } from './loop/archive';
import { getPiSessionId } from './loop/chat-engine';
import { broadcast } from './sse';

/** 与 admin-api.ts 的 AdminResponse 形状一致（提取处保持独立定义,不回头
 *  依赖 admin-api——绞杀纪律:抽出块不回指主文件）。 */
export interface AdminResponse {
  success: boolean;
  error?: string;
  hint?: string;
  data?: Record<string, unknown>;
  /** 与 admin-api.ts 的 AdminResponse 索引签名对齐（routeAdminApi 回 Record）。 */
  [key: string]: unknown;
}

/** 1.4.4 研究档案查询（GUI 研究面板初始加载/重连重放；auto-run 面板按
 *  run 的 loopSessionId 显式传入）。缺省当前 pi 会话线。 */
export function handleArchiveList(payload: { sessionId?: string }): AdminResponse {
  const sessionId = typeof payload?.sessionId === 'string' && payload.sessionId.trim()
    ? payload.sessionId.trim()
    : getPiSessionId();
  if (!sessionId) return { success: false, error: 'archive/list: 会话未锚定（先开/接会话）' };
  try {
    return { success: true, data: { archive: loadArchive(sessionId) as unknown as Record<string, unknown> } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 1.4.4 人纠正（行内纠正的一等操作；权威序：人 > 专家知识 > 模型自证伪
 *  ——人纠正后模型不得翻案）。纠正留痕 append-only + 下游待复核。 */
export async function handleArchiveCorrect(payload: {
  sessionId?: string;
  id?: string;
  reason?: string;
}): Promise<AdminResponse> {
  const sessionId = typeof payload?.sessionId === 'string' && payload.sessionId.trim()
    ? payload.sessionId.trim()
    : getPiSessionId();
  if (!sessionId) return { success: false, error: 'archive/correct: 会话未锚定（先开/接会话）' };
  const id = String(payload?.id ?? '').trim();
  if (!id) return { success: false, error: 'archive/correct: 需要 id（目标实体，如 C#1）' };
  const reason = String(payload?.reason ?? '').trim();
  if (!reason) return { success: false, error: 'archive/correct: 需要 reason（错在哪、为什么）' };
  try {
    const archive = await correctEntity(
      sessionId,
      { id, by: 'human', reason },
      { broadcastFn: broadcast },
    );
    return { success: true, data: { archive: archive as unknown as Record<string, unknown> } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
