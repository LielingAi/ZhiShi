/**
 * 1.4.9 — 已有环境的配方安装脚本重放（补齐链路）。
 *
 * 背景：能力重推只读不装工具（用户拍板——探测是顺手场景，带副作用违反
 * 最小惊讶），但「发现缺失之后没有下文」是断链。本模块是下文：对已有
 * 环境（ssh/docker/vm-address）重放配方的安装脚本——
 *
 *   - VM 配方 → setup.sh（自带 apt/pip sudo 安装段，1.4.9 已幂等化）；
 *   - docker 配方 → provision.sh（可选的裸机/VM 通用安装脚本，与
 *     Dockerfile 安装段同源——Dockerfile RUN 提取翻译是脆弱转换，不做）；
 *   - 两者皆无 → 明确报错（该配方无裸机安装脚本）。
 *
 * 纪律：
 *   - sudo 只认免密（`sudo -n true` 预检，不免密直接报错不进场——凭据
 *     不进新链路）；
 *   - 脚本经 base64 包装传输（多行脚本过 ssh argv 的唯一稳态），
 *     `base64 -d | bash` 在环境内执行；
 *   - 成功 → 调用方负责自动重推能力（闭环）；失败返回日志尾部供排障。
 *
 * 结构照 capability-derive.ts：脚本解析/包装是纯函数，provisionEnvironment
 * 是唯一 IO（exec 可注入，测试不碰真实通道）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { EnvironmentEntry } from '../../shared/config-types';
import type { EnvironmentRecipe } from './recipes';

/** provision 执行通道签名（与 env-exec 的 execInEnvironment 同形的最小子集）。 */
export type ProvisionExecFn = (
  entry: EnvironmentEntry,
  command: string,
  opts: { timeoutMs: number },
) => Promise<{ ok: boolean; exitCode?: number; stdout?: string; stderr?: string; error?: string }>;

/** provision 超时：安装含大下载（ZAP ~250MB 级 / joern-cli.zip），给足余量。 */
export const PROVISION_TIMEOUT_MS = 20 * 60 * 1000;

const SUDO_PRECHECK_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// 纯函数 — 脚本解析 / 包装 / sudo 判定
// ---------------------------------------------------------------------------

/** 配方 → 安装脚本（纯路径判定；存在性由调用方读盘确认）。
 *  VM 配方 → setup.sh；docker 配方 → provision.sh（可选的裸机安装脚本）。 */
export function provisionScriptCandidate(recipe: Pick<EnvironmentRecipe, 'dir' | 'base'>): { path: string; source: 'setup' | 'provision' } {
  return recipe.base === 'vm'
    ? { path: join(recipe.dir, 'setup.sh'), source: 'setup' }
    : { path: join(recipe.dir, 'provision.sh'), source: 'provision' };
}

/** 脚本是否含 sudo 调用（决定是否做免密预检）。 */
export function scriptNeedsSudo(script: string): boolean {
  return /(^|\s)sudo\s/.test(script);
}

/** base64 包装传输：`base64 -d | bash`——多行脚本过 ssh argv 的稳态形态。 */
export function wrapProvisionCommand(script: string): string {
  return `echo ${Buffer.from(script, 'utf8').toString('base64')} | base64 -d | bash`;
}

/** 日志尾部（排障用——安装日志动辄数千行，只回尾部）。 */
export function logTail(text: string, maxChars = 2000): string {
  const t = text.trim();
  return t.length > maxChars ? `…（前略）\n${t.slice(-maxChars)}` : t;
}

// ---------------------------------------------------------------------------
// 薄 IO — 读脚本 + 预检 + 执行（exec 可注入）
// ---------------------------------------------------------------------------

export interface ProvisionResult {
  ok: boolean;
  /** 实际执行的脚本来源（成功/失败都带——排障与留痕）。 */
  source?: 'setup' | 'provision';
  scriptPath?: string;
  error?: string;
  /** 失败（或成功）时的输出尾部。 */
  logTail?: string;
}

/**
 * 对一个已有环境重放配方的安装脚本。流程：解析脚本（VM→setup.sh /
 * docker→provision.sh）→ sudo 免密预检（脚本含 sudo 时）→ base64 包装执行。
 * 不做的事：按工具补齐（无 per-tool 粒度）、密码通道（凭据不进链路）。
 */
export async function provisionEnvironment(
  entry: EnvironmentEntry,
  recipe: EnvironmentRecipe,
  deps: { exec: ProvisionExecFn },
): Promise<ProvisionResult> {
  const candidate = provisionScriptCandidate(recipe);
  if (!existsSync(candidate.path)) {
    return {
      ok: false,
      error:
        recipe.base === 'vm'
          ? `配方 "${recipe.id}" 缺 setup.sh`
          : `配方 "${recipe.id}" 是容器配方且无 provision.sh（裸机安装脚本）——Dockerfile 的安装段不能重放到裸机/VM，需要为该配方补 provision.sh`,
    };
  }
  const script = readFileSync(candidate.path, 'utf8');

  if (scriptNeedsSudo(script)) {
    let pre;
    try {
      pre = await deps.exec(entry, 'sudo -n true', { timeoutMs: SUDO_PRECHECK_TIMEOUT_MS });
    } catch (err) {
      return { ok: false, source: candidate.source, scriptPath: candidate.path, error: `sudo 免密预检通道异常：${err instanceof Error ? err.message : String(err)}` };
    }
    if (!pre.ok || pre.exitCode !== 0) {
      return {
        ok: false,
        source: candidate.source,
        scriptPath: candidate.path,
        error: `环境 "${entry.id}" 的用户 sudo 需要密码——补齐链路不落凭据，请给该用户配免密 sudo 后重试`,
      };
    }
  }

  let r;
  try {
    r = await deps.exec(entry, wrapProvisionCommand(script), { timeoutMs: PROVISION_TIMEOUT_MS });
  } catch (err) {
    return { ok: false, source: candidate.source, scriptPath: candidate.path, error: `provision 通道异常：${err instanceof Error ? err.message : String(err)}` };
  }
  const tail = logTail(`${r.stdout ?? ''}\n${r.stderr ?? ''}`);
  if (!r.ok) {
    return { ok: false, source: candidate.source, scriptPath: candidate.path, error: r.error ?? 'provision 通道失败', logTail: tail };
  }
  // exitCode 缺省（窄通道只回 ok/stdout）按成功处理——只认显式非零。
  if (r.exitCode !== undefined && r.exitCode !== 0) {
    return { ok: false, source: candidate.source, scriptPath: candidate.path, error: `安装脚本退出码 ${r.exitCode}（详见日志尾部）`, logTail: tail };
  }
  return { ok: true, source: candidate.source, scriptPath: candidate.path, logTail: tail };
}
