/**
 * 1.8.4 — 研究面只读投影与蒸馏触发的 admin handler（dsh-zhishi-tools
 * 桥接场景）：claims/read（治理弧产物投影）+ research/distilled（安全
 * 蒸馏摘要投影）+ distill/run（手动触发两条蒸馏弧）。
 *
 * 与 admin-archive.ts 同族：薄组合——只调既有内部函数
 * （loop/session-claims、memory/distill-research、memory/distill-runner），
 * 零新逻辑。AdminResponse 独立定义（绞杀纪律：抽出块不回指 admin-api）。
 */

import { loadSessionClaims } from './loop/session-claims';
import { getPiSessionId } from './loop/chat-engine';
import { readResearchDistilled } from './memory/distill-research';
import { runDistillArc, runResearchDistillArc, type DistillArcResult } from './memory/distill-runner';

/** 与 admin-api.ts 的 AdminResponse 形状一致（提取处保持独立定义）。 */
export interface AdminResponse {
  success: boolean;
  error?: string;
  hint?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

function resolveSessionId(payload: { sessionId?: string }): string | null {
  const sessionId = typeof payload?.sessionId === 'string' && payload.sessionId.trim()
    ? payload.sessionId.trim()
    : getPiSessionId();
  return sessionId || null;
}

/** claims/read — 会话 claims（治理弧 Event→Claim 管线的产物）只读投影。
 *  缺省当前 pi 会话线；deps.dir 供测试注入临时目录。 */
export function handleClaimsRead(
  payload: { sessionId?: string },
  deps: { dir?: string } = {},
): AdminResponse {
  const sessionId = resolveSessionId(payload);
  if (!sessionId) return { success: false, error: 'claims/read: 会话未锚定（先开/接会话，或显式传 sessionId）' };
  try {
    const file = loadSessionClaims(sessionId, deps.dir ? { dir: deps.dir } : undefined);
    return {
      success: true,
      data: {
        claims: file.claims as unknown as Record<string, unknown>[],
        audits: file.audits as unknown as Record<string, unknown>[],
        nextSeq: file.meta.nextSeq,
      },
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** research/distilled — 安全蒸馏摘要（成功路径/失败根因/工具组合）只读
 *  投影。dsh 的 <zhishi-research-memory> 注入段经它读本体经验库。
 *  deps.baseDir 供测试注入。 */
export function handleResearchDistilled(
  _payload: unknown,
  deps: { baseDir?: string } = {},
): AdminResponse {
  try {
    const distilled = readResearchDistilled(deps.baseDir ? deps.baseDir : undefined);
    return { success: true, data: { distilled: distilled as unknown as Record<string, unknown> } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** distill/run — 手动触发蒸馏弧（cognitive / research / all，缺省 all）。
 *  workspacePath 必填（弧的工作史归属）。LLM 调用在弧内部——本路由是
 *  长耗时调用（调用方应放宽超时）；弧自带「无料不烧」判料。deps 供测试
 *  注入弧实现。 */
export interface DistillRunDeps {
  runCognitive?: typeof runDistillArc;
  runResearch?: typeof runResearchDistillArc;
}

export async function handleDistillRun(
  payload: { arc?: string; workspacePath?: string },
  deps: DistillRunDeps = {},
): Promise<AdminResponse> {
  const arc = typeof payload?.arc === 'string' && payload.arc.trim() ? payload.arc.trim() : 'all';
  if (arc !== 'cognitive' && arc !== 'research' && arc !== 'all') {
    return { success: false, error: `distill/run: 非法 arc "${arc}"（允许 cognitive / research / all）` };
  }
  const workspacePath = typeof payload?.workspacePath === 'string' ? payload.workspacePath.trim() : '';
  if (!workspacePath) {
    return { success: false, error: 'distill/run: workspacePath 必填（蒸馏弧的工作史归属）' };
  }
  const cognitive = deps.runCognitive ?? runDistillArc;
  const research = deps.runResearch ?? runResearchDistillArc;
  const data: Record<string, unknown> = {};
  try {
    if (arc === 'cognitive' || arc === 'all') {
      const r: DistillArcResult = await cognitive({ workspacePath });
      if (r.status !== 200) return { success: false, error: `认知弧失败: ${JSON.stringify(r.body).slice(0, 300)}` };
      data.cognitive = r.body;
    }
    if (arc === 'research' || arc === 'all') {
      const r: DistillArcResult = await research({ workspacePath });
      if (r.status !== 200) return { success: false, error: `安全弧失败: ${JSON.stringify(r.body).slice(0, 300)}` };
      data.research = r.body;
    }
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
