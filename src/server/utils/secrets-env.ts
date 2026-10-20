/**
 * secrets.env —— 集中式密码引用的落点（2.0.4 只密码设备主链）。
 *
 * 背景（D-T4：密码本体不落盘）：只密码设备（推不进公钥的嵌入式/网络设备/
 * 老服务器）的环境条目只存 `passwordRef`（如 `env:CAM01_PW`），执行时经
 * `resolvePasswordRef`（loop/env-exec.ts）从**执行机**进程环境现场取。
 * 设备一多，散落的系统环境变量难管——本模块约定一个集中文件：
 *
 *   <数据目录>/secrets.env        （如 ~/.zhishi/secrets.env）
 *
 *     # 每台只密码设备一行，KEY=VALUE
 *     CAM01_PW=xxxx
 *     SWITCH_PW=yyyy
 *
 * sidecar 启动时加载进进程环境（**不覆盖**已存在的同名变量——真实环境
 * 变量优先），之后 `env:XXX` 引用零改动生效。文件语义 = 执行机的本地
 * 秘密，与 config.json 同级的「本机私货」：不进备份/同步/团队线，权限
 * 应为 600（非 unix 平台跳过权限检查）。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** secrets 文件名（固定，数据目录根）。 */
export const SECRETS_ENV_FILE = 'secrets.env';

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 解析 secrets.env 内容（纯函数）：`KEY=VALUE` 行；`#` 开头与空行跳过；
 * `export ` 前缀容忍；值剥匹配的单/双引号；非法行跳过（不炸加载——一个
 * 手误不该让整个 secret 集失效；调用方日志可见计数差）。
 */
export function parseSecretsEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!KEY_RE.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    out[key] = value;
  }
  return out;
}

/**
 * 从数据目录加载 secrets.env（存在才动；缺文件 = 零动作不是错）。
 * 已存在的进程环境变量优先（`??=`）——systemd/服务态显式注入的覆盖文件。
 * 返回加载条数（0 = 无文件或全空）；unix 上权限松于 600 时经 onWarn 告警。
 */
export function loadSecretsEnv(
  dataDir: string,
  onWarn?: (message: string) => void,
): number {
  const path = join(dataDir, SECRETS_ENV_FILE);
  if (!existsSync(path)) return 0;

  if (process.platform !== 'win32') {
    try {
      const mode = statSync(path).mode & 0o777;
      if (mode & 0o077) {
        onWarn?.(`secrets.env 权限过松（${mode.toString(8)}）——建议 chmod 600（同机其他用户可读）`);
      }
    } catch { /* best-effort */ }
  }

  let parsed: Record<string, string>;
  try {
    parsed = parseSecretsEnv(readFileSync(path, 'utf-8'));
  } catch (err) {
    onWarn?.(`secrets.env 读取失败（跳过加载）：${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }

  let loaded = 0;
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] !== undefined) continue;
    process.env[key] = value;
    loaded++;
  }
  return loaded;
}
