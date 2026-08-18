/**
 * W1(design-spec §6.1「回现场」/ §6.4 `/snapshot` `/rollback @snap`)—
 * 登记 VM 环境的快照/回滚原语:vm-lifecycle 的 vmrun 构件暴露成
 * admin API 用的操作层(exec 注入化,单测绝不真调 vmrun)。
 *
 * 语义对齐 env up 的 revert(vmEnvUp 的快照约定):
 *   - snapshot:vmrun snapshot,名称缺省 zhishi-<ts>;
 *   - rollback:运行中先 stop soft(失败自动补 hard——回滚是显式丢现场
 *     动作,guest 无响应不该卡住它)→ revertToSnapshot → 原本在跑则
 *     start nogui 恢复可用(env up 的 revert 后同样 start)。
 *
 * docker 环境:admin-api 层直接回「暂未支持」(本模块只管 vmware)。
 */

import type { EnvResult } from '../loop/env-exec';
import {
  buildVmrunListArgs,
  buildVmrunListSnapshotsArgs,
  buildVmrunRevertArgs,
  buildVmrunSnapshotArgs,
  buildVmrunStartArgs,
  buildVmrunStopArgs,
  defaultVmrunExec,
  normalizeVmxPath,
  outputTailOf,
  parseVmrunList,
  parseVmrunSnapshotList,
  VMRUN_LIST_TIMEOUT_MS,
  VMRUN_START_TIMEOUT_MS,
  VMRUN_STOP_TIMEOUT_MS,
  type VmExec,
} from './vm-lifecycle';

export interface VmSnapshotOptions {
  exec?: VmExec;
  /** 测试注入:快照名缺省值的时间戳(缺省 Date.now)。 */
  now?: () => number;
}

/** 快照名白名单:字母数字/._-(vmrun 与后续 /rollback @名 解析都省心)。 */
const SNAPSHOT_NAME_RE = /^[\w.-]+$/;

export function defaultSnapshotName(now: number): string {
  return `zhishi-${now}`;
}

/** vmrun snapshot。名称缺省 zhishi-<ts>;非法名/失败都给可读错误。 */
export async function snapshotVm(
  vmx: string,
  name?: string,
  options: VmSnapshotOptions = {},
): Promise<EnvResult<{ name: string }>> {
  const exec = options.exec ?? defaultVmrunExec;
  const snapshotName = name?.trim() || defaultSnapshotName((options.now ?? Date.now)());
  if (!SNAPSHOT_NAME_RE.test(snapshotName)) {
    return {
      ok: false,
      error: `快照名 "${snapshotName}" 非法:只允许字母/数字/._-(收到含其他字符的名字)`,
    };
  }
  // 60s 而非通用 120s:vmrun snapshot 正常 10–30s;超时一律走 listSnapshots
  // 复核(下面),挂起型失败不会让操作员干等两分钟。
  const result = await exec(['vmrun', ...buildVmrunSnapshotArgs(vmx, snapshotName)], 60_000);
  if (result.exitCode !== 0 || result.error) {
    // vmrun「挂起后成功」前科(2026-08-17 活体实测):运行中 VM 的 snapshot
    // 会创建成功但进程不退出,120s 超时误报失败。超时/失败时用
    // listSnapshots 复核——快照已落则视为成功,只多一次亚秒级查询。
    const list = await exec(['vmrun', ...buildVmrunListSnapshotsArgs(vmx)], VMRUN_LIST_TIMEOUT_MS);
    const names = list.exitCode === 0 && !list.error ? parseVmrunSnapshotList(list.stdout) : [];
    if (names.includes(snapshotName)) {
      return { ok: true, name: snapshotName };
    }
    return {
      ok: false,
      error: `vmrun snapshot "${snapshotName}" 失败(${vmx}):\n${outputTailOf(result)}`,
    };
  }
  return { ok: true, name: snapshotName };
}

/**
 * vmrun revertToSnapshot。运行中先停(soft,失败补 hard),revert 后若原本
 * 在跑则 start nogui 恢复现场可用。任一步失败返回可读错误(含 vmrun 输出尾)。
 */
export async function rollbackVm(
  vmx: string,
  snapshot: string,
  options: VmSnapshotOptions = {},
): Promise<EnvResult<{ snapshot: string; restarted: boolean }>> {
  const exec = options.exec ?? defaultVmrunExec;
  const name = snapshot.trim();
  if (!name) {
    return { ok: false, error: '缺少快照名(用法:environment/rollback {id, snapshot})' };
  }

  // ① 运行状态:运行中先停——revert 一个运行中的 VM 依赖 vmrun 隐式处理,
  //    显式 stop 让语义对齐 env up 的 revert(停机 → revert → start)。
  const listResult = await exec(['vmrun', ...buildVmrunListArgs()], VMRUN_LIST_TIMEOUT_MS);
  if (listResult.exitCode !== 0 || listResult.error) {
    return {
      ok: false,
      error: `vmrun list 失败(VMware 不可用?):\n${outputTailOf(listResult)}`,
    };
  }
  const wasRunning = parseVmrunList(listResult.stdout).some(
    (p) => normalizeVmxPath(p) === normalizeVmxPath(vmx),
  );

  if (wasRunning) {
    const stopResult = await exec(['vmrun', ...buildVmrunStopArgs(vmx)], VMRUN_STOP_TIMEOUT_MS);
    if (stopResult.exitCode !== 0 || stopResult.error) {
      // guest 无响应(Tools 不在/卡死):回滚是显式丢现场动作,补 hard stop。
      const hardResult = await exec(['vmrun', '-T', 'ws', 'stop', vmx, 'hard'], VMRUN_STOP_TIMEOUT_MS);
      if (hardResult.exitCode !== 0 || hardResult.error) {
        return {
          ok: false,
          error: `回滚前停止 VM 失败(soft 与 hard 均未成,${vmx}):\n${outputTailOf(hardResult)}`,
        };
      }
    }
  }

  // ② revert(语义同 env up 的 revertToSnapshot 挂点)。
  const revertResult = await exec(['vmrun', ...buildVmrunRevertArgs(vmx, name)], VMRUN_START_TIMEOUT_MS);
  if (revertResult.exitCode !== 0 || revertResult.error) {
    return {
      ok: false,
      error:
        `revertToSnapshot "${name}" 失败(${vmx}):\n${outputTailOf(revertResult)}\n` +
        '快照名可用 vmrun -T ws listSnapshots <vmx> 核对。',
    };
  }

  // ③ 原本在跑 → start nogui 恢复可用(快照可能存的是停机态,显式拉起)。
  let restarted = false;
  if (wasRunning) {
    const afterList = await exec(['vmrun', ...buildVmrunListArgs()], VMRUN_LIST_TIMEOUT_MS);
    const stillRunning = afterList.exitCode === 0 && !afterList.error
      && parseVmrunList(afterList.stdout).some((p) => normalizeVmxPath(p) === normalizeVmxPath(vmx));
    if (!stillRunning) {
      const startResult = await exec(['vmrun', ...buildVmrunStartArgs(vmx)], VMRUN_START_TIMEOUT_MS);
      if (startResult.exitCode !== 0 || startResult.error) {
        return {
          ok: false,
          error:
            `已回滚到 "${name}",但重新启动失败(${vmx}):\n${outputTailOf(startResult)}\n` +
            '可手动 zhishi env up 拉起。',
        };
      }
      restarted = true;
    }
  }
  return { ok: true, snapshot: name, restarted };
}
