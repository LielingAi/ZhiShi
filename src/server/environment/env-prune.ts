/**
 * 2.0-M1 僵尸清理候选选择器（纯函数，2.0 audit 可测化 + P3 探活外提配套）。
 *
 * 判据（保守：宁可漏报不误杀）——handler 负责把世界状态采样成入参，
 * 本模块只做判定：
 *   - 已登记、非内置本机、非 ssh（远端探活成本高，保守排除）
 *   - 未被任何线映射引用（无 `env:<id>` 行 = 无使用史）
 *   - 无活跃 auto-run 引用
 *   - 非占用中（1.8.7 P5 envOccupancy）
 *   - 探活：docker/vm 正在跑 → 排除；**探测失败/不可知 → 排除**（fail-closed，
 *     D14 销毁纪律的第一道保险）
 *
 * 时间判据说明：设计稿「停止超 7 天」落地不了——EnvEntry 无时间戳；
 * v1 以「零使用痕迹」替代（更硬：无映射的环境不需要等 7 天）。
 */

export type PruneProbeState = 'running' | 'stopped' | 'unknown';

export interface PruneEntryLike {
  id: string;
  kind?: string;
  name?: string;
  container?: string;
  vmName?: string;
}

export interface PruneInputs {
  entries: PruneEntryLike[];
  /** env-sessions 行引用的 envKey 集合（`env:<id>` 形态）。 */
  usedEnvRefs: Set<string>;
  /** 活跃 auto-run 的 envKey 集合（`env:<id>` 形态）。 */
  activeRunEnvs: Set<string>;
  /** 占用中的环境 id 集合。 */
  occupiedIds: Set<string>;
  /** 每环境探活结果（缺省=unknown，selector 按 fail-closed 排除）。 */
  probe: Record<string, PruneProbeState>;
}

export interface PruneCandidate {
  id: string;
  name: string;
  kind: string;
  detail: string;
  reason: string;
}

export function selectPruneCandidates(inputs: PruneInputs, localEnvId: string): PruneCandidate[] {
  const out: PruneCandidate[] = [];
  for (const entry of inputs.entries) {
    if (entry.id === localEnvId) continue;
    if (entry.kind === 'ssh' || entry.kind === 'local') continue;
    const ref = `env:${entry.id}`;
    if (inputs.usedEnvRefs.has(ref)) continue;
    if (inputs.activeRunEnvs.has(ref)) continue;
    if (inputs.occupiedIds.has(entry.id)) continue;
    const state = inputs.probe[entry.id] ?? 'unknown';
    if (state !== 'stopped') continue; // running / unknown（探测失败）→ fail-closed
    out.push({
      id: entry.id,
      name: entry.name ?? entry.id,
      kind: entry.kind ?? 'env',
      detail: entry.container ?? entry.vmName ?? '',
      reason: '无使用痕迹（无分线映射 / 无活跃任务）+ 已停止',
    });
  }
  return out;
}
