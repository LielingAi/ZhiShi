/**
 * 1.4.7 — 研究档案 admin handler（god file 绞杀续拆）：从 admin-api.ts 抽出
 * 的 archive/list + archive/correct 两个 handler。纯搬移、行为零变化；
 * admin-api.ts re-export 保持既有调用点（index.ts routeAdminApi）不动。
 */

import { abandonEntity, correctEntity, loadArchive, resolveHypothesis, resolveQuestion } from './loop/archive';
import { getPiSessionId } from './loop/chat-engine';
import { createArchiveTool } from './loop/tools';
import { broadcast } from './sse';
// 1.8.7 P2 署名：人纠正的 byUser = 请求 actor（token 命中即真实成员名）。
import { currentActor } from './auth/actor';

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
      // P2：byUser = 请求 actor（团队大脑下回答「谁纠正的」；本地模式 = LOCAL）。
      { id, by: 'human', byUser: currentActor().name, reason },
      { broadcastFn: broadcast },
    );
    return { success: true, data: { archive: archive as unknown as Record<string, unknown> } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 假设证实 / 问题解决（终态推进的一等操作；GUI 档案行「✓ 证实」入口）。
 *  按实体类型路由：H# → confirmed，Q# → resolved；其他类型报错。 */
export async function handleArchiveResolve(payload: {
  sessionId?: string;
  id?: string;
  note?: string;
}): Promise<AdminResponse> {
  const sessionId = typeof payload?.sessionId === 'string' && payload.sessionId.trim()
    ? payload.sessionId.trim()
    : getPiSessionId();
  if (!sessionId) return { success: false, error: 'archive/resolve: 会话未锚定（先开/接会话）' };
  const id = String(payload?.id ?? '').trim();
  if (!id) return { success: false, error: 'archive/resolve: 需要 id（目标实体，如 H#1/Q#1）' };
  const note = typeof payload?.note === 'string' && payload.note.trim() ? payload.note.trim() : undefined;
  try {
    const kind = loadArchive(sessionId).entities.find((e) => e.id === id)?.kind;
    if (kind === 'hypothesis') {
      const archive = await resolveHypothesis(sessionId, { id, note }, { broadcastFn: broadcast });
      return { success: true, data: { archive: archive as unknown as Record<string, unknown> } };
    }
    if (kind === 'question') {
      const archive = await resolveQuestion(sessionId, { id, note }, { broadcastFn: broadcast });
      return { success: true, data: { archive: archive as unknown as Record<string, unknown> } };
    }
    return { success: false, error: `archive/resolve: 只作用于假设(H#N)或未决问题(Q#N)——${id} ${kind ? `是 ${kind}` : '不存在'}` };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 搁置假设/未决问题（1.4.8 第三终态；GUI 档案行「搁置」入口）。
 *  「不追了」≠「错了」——终态推进留 note，不进纠正台账。 */
export async function handleArchiveAbandon(payload: {
  sessionId?: string;
  id?: string;
  reason?: string;
}): Promise<AdminResponse> {
  const sessionId = typeof payload?.sessionId === 'string' && payload.sessionId.trim()
    ? payload.sessionId.trim()
    : getPiSessionId();
  if (!sessionId) return { success: false, error: 'archive/abandon: 会话未锚定（先开/接会话）' };
  const id = String(payload?.id ?? '').trim();
  if (!id) return { success: false, error: 'archive/abandon: 需要 id（目标实体，如 H#1/Q#1）' };
  const reason = String(payload?.reason ?? '').trim();
  if (!reason) return { success: false, error: 'archive/abandon: 需要 reason（为什么不追了——留痕）' };
  try {
    const archive = await abandonEntity(sessionId, { id, note: reason }, { broadcastFn: broadcast });
    return { success: true, data: { archive: archive as unknown as Record<string, unknown> } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 1.8.4 — archive/op：模型语义的档案写（dsh-zhishi-tools 桥接场景——
 *  外部 harness 的会话把研究实体写进指定 loop 线）。复用 loop 的
 *  research_archive 工具执行体：举证强度（finding 必挂已存在 V#）/挂链
 *  纪律/终态语义与本体内 agent 调用逐字同口径——不平行实现第二套。
 *  broadcastFn 用真广播，GUI 研究面板实时更新；deps.dir 供测试注入。 */
export interface ArchiveOpPayload {
  sessionId?: string;
  op?: string;
  text?: string;
  findingType?: string;
  refs?: string;
  against?: string;
  anchor?: string;
  id?: string;
  reason?: string;
  note?: string;
}

export async function handleArchiveOp(
  payload: ArchiveOpPayload,
  deps: { dir?: string } = {},
): Promise<AdminResponse> {
  const sessionId = typeof payload?.sessionId === 'string' && payload.sessionId.trim()
    ? payload.sessionId.trim()
    : getPiSessionId();
  if (!sessionId) return { success: false, error: 'archive/op: 会话未锚定（先开/接会话，或显式传 sessionId）' };
  const tool = createArchiveTool({
    getSessionId: () => sessionId,
    ...(deps.dir ? { dir: deps.dir } : {}),
    broadcastFn: broadcast,
  });
  try {
    const result = await tool.execute(`admin-archive-op-${Date.now()}`, payload as never);
    const text = result.content.find((c) => c.type === 'text')?.text ?? '';
    return { success: true, data: { text, entityId: result.details?.entityId ?? null } };
  } catch (err) {
    // 工具的执行期校验（举证强度/终态门/非法引用）抛出的是模型可读的
    // 纪律文本——原样回注，调用方（外部 agent）按它纠正行为。
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
