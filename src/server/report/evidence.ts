/**
 * 1.2.0 — 证据批量回收（薄 IO；exec 可注入，单测绝不真碰 scp）。
 *
 * 前提：调用方（export.ts）已拿到一次批量 boundary 批准——本模块内部
 * 绝不再问人（与 environment/extract 的逐次问相反，design「证据回收链」：
 * 落点 + 全部 N 个证据文件一次列清，人批一次全收）。
 *
 * 降级语义（一律保留环境内路径 + 如实标注，不炸导出）：
 *   - 未锚定环境（host 选定）→ 「证据回收未执行」；
 *   - docker 环境 → 「docker 环境回收未支持」（design 明确不做 docker cp）；
 *   - ssh target 解析失败（VM 无地址等）→ 整批降级；
 *   - 单个文件 scp 失败 → 该文件降级，其余继续。
 *
 * scp argv 构造与 environment/extract 共用 buildScpArgv（两条回收路径
 * 形态一致）；执行走 defaultEnvExec（与 env_exec 同一 spawn 纪律）。
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { EnvironmentEntry } from '../../shared/config-types';
import {
  buildScpArgv,
  defaultEnvExec,
  resolveSshTarget,
  type EnvExec,
} from '../loop/env-exec';
import type { EvidenceRecovery, EvidenceRef } from './skeleton';

/** 单文件回收超时（与 environment/extract 的 120s 一致）。 */
export const SCP_TIMEOUT_MS = 120_000;

export interface ScpResult {
  ok: boolean;
  /** ok：回收到的宿主路径（destDir + guestPath 基名）。 */
  savedTo?: string;
  error?: string;
}

/** 回收一个环境内文件到宿主目录（scp argv 与 environment/extract 同构）。 */
export async function scpGuestFile(
  target: Parameters<typeof buildScpArgv>[0],
  guestPath: string,
  destDir: string,
  exec: EnvExec = defaultEnvExec,
): Promise<ScpResult> {
  const argv = buildScpArgv(target, guestPath, destDir);
  let result: Awaited<ReturnType<EnvExec>>;
  try {
    result = await exec(argv, SCP_TIMEOUT_MS);
  } catch (err) {
    return { ok: false, error: `scp 执行异常：${err instanceof Error ? err.message : String(err)}` };
  }
  if (result.error && result.exitCode < 0) {
    return { ok: false, error: result.error };
  }
  if (result.exitCode !== 0) {
    const tail = result.stderr.trim().split('\n').slice(-3).join('\n');
    return { ok: false, error: `scp 提取失败(exit=${result.exitCode})${tail ? `：${tail}` : ''}` };
  }
  const base = guestPath.replace(/\/+$/, '').split('/').pop() ?? 'extracted';
  return { ok: true, savedTo: join(destDir, base) };
}

/**
 * 批量回收（已批准前提）。同 guestPath 多事件登记只收一次（scp 去重），
 * 各事件的标注共享同一份结果。
 */
export async function recoverEvidenceBatch(
  entry: EnvironmentEntry | null,
  refs: EvidenceRef[],
  destDir: string,
  exec: EnvExec = defaultEnvExec,
): Promise<EvidenceRecovery[]> {
  if (refs.length === 0) return [];

  const degradeAll = (note: string): EvidenceRecovery[] =>
    refs.map((ref) => ({ eventId: ref.eventId, guestPath: ref.guestPath, status: 'degraded', note }));

  if (!entry) {
    return degradeAll('未锚定环境（host 选定）——证据回收未执行，保留环境内路径');
  }
  if (entry.kind === 'docker') {
    return degradeAll('docker 环境回收未支持——保留环境内路径');
  }
  const resolved = resolveSshTarget(entry);
  if (!resolved.ok) {
    return degradeAll(`环境不可达：${resolved.error}——保留环境内路径`);
  }

  mkdirSync(destDir, { recursive: true });
  const byPath = new Map<string, ScpResult>();
  const out: EvidenceRecovery[] = [];
  for (const ref of refs) {
    let result = byPath.get(ref.guestPath);
    if (!result) {
      result = await scpGuestFile(resolved.target, ref.guestPath, destDir, exec);
      byPath.set(ref.guestPath, result);
    }
    if (result.ok) {
      out.push({ eventId: ref.eventId, guestPath: ref.guestPath, status: 'recovered', savedTo: result.savedTo });
    } else {
      out.push({
        eventId: ref.eventId,
        guestPath: ref.guestPath,
        status: 'degraded',
        note: `${result.error}——保留环境内路径`,
      });
    }
  }
  return out;
}
