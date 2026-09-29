/**
 * 1.8.7 P3b 团队大脑——研究线管理面（双线制）。
 *
 *   line/list    只读——某 workspace 的分线清单（归属段/owner/shared/
 *                live/busy/调用方当前线标记），`zhishi line list` 数据源。
 *   line/share   操作员起——把一条**私有线**转为共享线（reviewer 或该线
 *                owner；归属未知旧线仅 reviewer）：owner 保留作署名，
 *                shared 置位，env-sessions 映射行重挂 `shared` 归属段。
 *   line/unshare 操作员起——共享线转回私有（reviewer 或 owner）：shared
 *                落位，**归属改登记为调用方**（设计稿：取消共享即归为
 *                发起者的私有线），映射行重挂调用方归属段。
 *
 * 归属元数据在 loop/line-ownership.ts；权限矩阵在 auth/line-access.ts；
 * 路由角色底档在 auth/roles.ts（operator——owner 可能是 operator，owner/
 * reviewer 复核在本模块内做）。
 */

import { currentActor, type Actor } from '../auth/actor';
import { canReadLine } from '../auth/line-access';
import { roleAtLeast } from '../auth/roles';
import {
  loadEnvSessionsMap,
  normalizeWorkspaceKey,
  retargetEnvSessionLines,
  SHARED_LINE_SEGMENT,
} from '../environment/env-sessions';
import {
  getActiveLoopSessionId,
  getLiveEngineState,
  hasLiveEngine,
  resolveLineAddress,
} from './chat-engine';
import { getLineOwnership, setLineShared, type LineOwnership } from './line-ownership';

/** 与 admin-api.ts 的 AdminResponse 形状一致（独立定义,不回头依赖主文件）。 */
export interface AdminResponse {
  success: boolean;
  error?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

/** share/unshare 的「谁能动这条线」：reviewer 或该线 owner（本机恒放行）。 */
function canAdministerLine(actor: Actor, ownership: LineOwnership | undefined): boolean {
  if (actor.source === 'local') return true;
  if (roleAtLeast(actor.role, 'reviewer')) return true;
  return !!ownership?.owner && ownership.owner === actor.name;
}

function readLoopSessionId(payload: { loopSessionId?: unknown }): string {
  return typeof payload.loopSessionId === 'string' && payload.loopSessionId.trim()
    ? payload.loopSessionId.trim()
    : '';
}

/** `line/list` — 某 workspace 的分线清单（含归属与 live/忙碌/当前线标记）。 */
export function handleLineList(payload: { workspace?: unknown }): AdminResponse {
  const workspace = typeof payload.workspace === 'string' && payload.workspace.trim()
    ? payload.workspace.trim()
    : '';
  if (!workspace) return { success: false, error: 'Missing required argument: <workspace>' };
  const prefix = `${normalizeWorkspaceKey(workspace)}::`;
  const map = loadEnvSessionsMap();
  const active = getActiveLoopSessionId();
  const caller = currentActor();
  const lines: Array<Record<string, unknown>> = [];
  for (const [key, line] of Object.entries(map.lines)) {
    if (!key.startsWith(prefix)) continue;
    const ownership = getLineOwnership(line.loopSessionId);
    // 读权限即清单可见性:他人的私有线不出现在非主非 reviewer 的清单里
    // (存在性也是私有信息)。
    if (!canReadLine(caller, ownership)) continue;
    const suffix = key.slice(prefix.length);
    const sep = suffix.indexOf('::');
    // 三段式 = `<归属段>::<envKey>`;两段式 = 旧键（归属段记 legacy）。
    const segment = sep >= 0 ? suffix.slice(0, sep) : 'legacy';
    const envKey = sep >= 0 ? suffix.slice(sep + 2) : suffix;
    const liveState = getLiveEngineState(line.loopSessionId);
    lines.push({
      loopSessionId: line.loopSessionId,
      envKey,
      segment,
      owner: ownership?.owner ?? null,
      shared: ownership?.shared === true,
      live: hasLiveEngine(line.loopSessionId),
      busy: liveState?.sessionState === 'running',
      active: line.loopSessionId === active,
      updatedAt: line.updatedAt,
    });
  }
  return { success: true, data: { workspace, activeLoopSessionId: active, lines } };
}

/** `line/share` — 私有线 → 共享线（reviewer 或 owner；归属未知旧线仅 reviewer）。 */
export async function handleLineShare(payload: { loopSessionId?: unknown }): Promise<AdminResponse> {
  const loopSessionId = readLoopSessionId(payload);
  if (!loopSessionId) return { success: false, error: 'Missing required argument: <loopSessionId>' };
  if (resolveLineAddress(loopSessionId) === 'unknown') {
    return { success: false, error: `loop session '${loopSessionId}' not found` };
  }
  const actor = currentActor();
  const ownership = getLineOwnership(loopSessionId);
  if (ownership?.shared) {
    return { success: true, data: { loopSessionId, shared: true, already: true } };
  }
  if (!canAdministerLine(actor, ownership)) {
    return { success: false, error: 'forbidden' };
  }
  // owner 保留(共享线上的产物署名仍归原主);shared 置位;映射行重挂 shared 段。
  await setLineShared(loopSessionId, true, undefined);
  await retargetEnvSessionLines(loopSessionId, SHARED_LINE_SEGMENT);
  console.log(`[line] ${actor.name} 共享了研究线 ${loopSessionId}`);
  return { success: true, data: { loopSessionId, shared: true, owner: ownership?.owner ?? null } };
}

/** `line/unshare` — 共享线 → 私有线,归属改登记为调用方（reviewer 或 owner）。 */
export async function handleLineUnshare(payload: { loopSessionId?: unknown }): Promise<AdminResponse> {
  const loopSessionId = readLoopSessionId(payload);
  if (!loopSessionId) return { success: false, error: 'Missing required argument: <loopSessionId>' };
  if (resolveLineAddress(loopSessionId) === 'unknown') {
    return { success: false, error: `loop session '${loopSessionId}' not found` };
  }
  const actor = currentActor();
  const ownership = getLineOwnership(loopSessionId);
  if (!ownership?.shared) {
    return { success: true, data: { loopSessionId, shared: false, already: true } };
  }
  if (!canAdministerLine(actor, ownership)) {
    return { success: false, error: 'forbidden' };
  }
  await setLineShared(loopSessionId, false, actor.name);
  await retargetEnvSessionLines(loopSessionId, actor.name);
  console.log(`[line] ${actor.name} 取消共享研究线 ${loopSessionId}(归属改登记为 ${actor.name})`);
  return { success: true, data: { loopSessionId, shared: false, owner: actor.name } };
}
