/**
 * 安全研究员版 P1 E3 — named-environment registry (pure logic).
 *
 * 具名环境条目存于 config.json 的 `environments` 数组（TS 类型见
 * shared/config-types.ts::EnvironmentEntry，缺省视同 []——老配置无此字段）。
 * 本模块只含纯函数：条目校验（按 kind 校必填字段）、id 唯一的增删查、
 * 以及把条目解析成 `term open --cmd` 的接入命令字符串；所有 I/O
 * （config.json 读写、panel-api 代理）都在 admin-api 层。
 *
 * 凭据规则（D-T4）：只存 `keyPath`（私钥路径引用），不存密码——校验直接
 * 拒绝 password/passphrase 字段。
 */

import type { EnvironmentEntry, EnvironmentKind } from '../../shared/config-types';
import { osFamilyOf } from './os-family';

export type { EnvironmentEntry, EnvironmentKind };

export const ENVIRONMENT_KINDS: readonly Exclude<EnvironmentKind, 'local'>[] = ['ssh', 'docker', 'vm'];

/**
 * 1.7.8 内置本机条目（design/local-env-design.md）：kind='local' 的虚拟
 * 条目，id 恒为 'local'，os_family='windows'，无凭据字段——开箱即随环境
 * 清单出现，不经 add 流程（语义上 = HOST_SELECTION 从「禁用态」转正为
 * 「可锚定环境」）。
 *
 * 内置 ≠ 落盘：config.json 平时不含本条目（add/rm/rename/迁移等全部
 * 写回路径因此零侵入）；只有探测刷新落能力字段时才物化一份带状态的
 * 副本进 config（此后清单用落盘副本，见 admin-api capability-refresh）。
 */
export const LOCAL_ENV_ID = 'local';

/** 构造内置本机条目（每次返回新对象，调用方可安全展开改写）。 */
export function builtinLocalEntry(): EnvironmentEntry {
  return {
    id: LOCAL_ENV_ID,
    kind: 'local',
    name: '本机（Windows 宿主）',
    osFamily: 'windows',
    createdAt: '',
  };
}

/** 清单是否已含本机条目（config 落盘副本或用户手工条目）。 */
export function hasLocalEnvironment(entries: readonly EnvironmentEntry[] | undefined): boolean {
  return (entries ?? []).some((e) => e.id === LOCAL_ENV_ID);
}

/**
 * 读侧清单 = config 条目 + 内置本机条目（config 已含 'local' 时不重复
 * 出现——落盘副本优先，物化后状态字段（localToolchain 等）不丢）。仅供
 * 只读消费方（list/select/能力清单/会话锚定）；写回一律用 listEnvironments
 * 的原始 config 口径，防止把虚拟条目 persisted 进 config.json。
 */
export function listEnvironmentsWithBuiltin(config: {
  environments?: EnvironmentEntry[];
  [key: string]: unknown;
}): EnvironmentEntry[] {
  const entries = listEnvironments(config);
  return hasLocalEnvironment(entries) ? entries : [builtinLocalEntry(), ...entries];
}

export type EnvResult<T> = { ok: true } & T | { ok: false; error: string };

/** Input after validation: everything except server-stamped `createdAt`. */
export type EnvironmentEntryInput = Omit<EnvironmentEntry, 'createdAt'>;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** D-T4: fields that must never reach config.json. */
const FORBIDDEN_SECRET_FIELDS = ['password', 'passphrase'] as const;

/** Optional free-text fields common to all kinds. */
const OPTIONAL_STRING_FIELDS = ['name', 'user', 'keyPath', 'passwordRef', 'osFamily', 'recipeId', 'host', 'container', 'vmName', 'address', 'vmx', 'workspace'] as const;

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function readOptionalString(
  source: Record<string, unknown>,
  field: string,
): { value?: string; error?: string } {
  const raw = source[field];
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'string') {
    return { error: `env 字段 "${field}" 必须是字符串` };
  }
  const trimmed = raw.trim();
  return trimmed ? { value: trimmed } : {};
}

/**
 * Validate raw input (CLI flags / admin payload) into a clean entry.
 * Per-kind required fields: ssh→host, docker→container, vm→vmName.
 * vm.address stays optional (its absence is an *open-time* error, not a
 * config error — the entry may be registered before the VM gets a network).
 */
export function validateEnvironmentEntry(input: unknown): EnvResult<{ entry: EnvironmentEntryInput }> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return fail('env add 需要参数对象（--kind/--id/...）');
  }
  const source = input as Record<string, unknown>;

  for (const secret of FORBIDDEN_SECRET_FIELDS) {
    if (source[secret] !== undefined && source[secret] !== null && source[secret] !== '') {
      return fail(`不存储密码类字段 "${secret}"（D-T4）：请改用 keyPath 引用私钥文件`);
    }
  }

  const id = typeof source.id === 'string' ? source.id.trim() : '';
  if (!id) return fail('缺少必填字段：id（--id）');
  if (!ID_PATTERN.test(id)) {
    return fail(`环境 id "${id}" 非法：仅限字母数字开头 + [A-Za-z0-9._-]，最长 64 字符`);
  }

  const kind = source.kind;
  // 'local' 是内置 kind（builtinLocalEntry），不经 add 流程——落入通用
  // 非法 kind 错误（可选清单不含它），语义正确且消息清晰。
  if (typeof kind !== 'string' || !ENVIRONMENT_KINDS.includes(kind as (typeof ENVIRONMENT_KINDS)[number])) {
    return fail(`缺少或非法的 kind：${JSON.stringify(kind)}（可选：${ENVIRONMENT_KINDS.join(' / ')}）`);
  }

  const entry: EnvironmentEntryInput = { id, kind: kind as (typeof ENVIRONMENT_KINDS)[number] };
  for (const field of OPTIONAL_STRING_FIELDS) {
    const { value, error } = readOptionalString(source, field);
    if (error) return fail(error);
    if (value !== undefined) {
      (entry as unknown as Record<string, string>)[field] = value;
    }
  }

  // 多配方绑定集合（1.3.8 关联侧）：可选字符串数组，trim + 去重 + 保序。
  // 1.5.10 一致性修复——登记条目主配方归位三态：
  //   1) 只有 recipeIds 无 recipeId → 主配方=绑定集合首项（recipeId = recipeIds[0]，
  //      写进条目；GUI「本机已有」/SSH 多选绑定正是这种载荷，原实现会留下
  //      缺主配方的条目）；
  //   2) recipeId 与 recipeIds 都有且 recipeId 在集合内 → 照旧；
  //   3) 两者都有但 recipeId 不在集合 → 自动并入集合（保序追加），不再拒绝。
  // 两者都没有 → 照旧无配方字段。
  if (source.recipeIds !== undefined && source.recipeIds !== null) {
    if (!Array.isArray(source.recipeIds)) {
      return fail('env 字段 "recipeIds" 必须是字符串数组');
    }
    const ids: string[] = [];
    for (const raw of source.recipeIds) {
      if (typeof raw !== 'string') return fail('env 字段 "recipeIds" 必须是字符串数组');
      const trimmed = raw.trim();
      if (!trimmed) continue;
      if (!ids.includes(trimmed)) ids.push(trimmed);
    }
    if (ids.length > 0) {
      entry.recipeIds = ids;
      if (!entry.recipeId) {
        // 主配方=绑定集合首项
        entry.recipeId = ids[0];
      } else if (!ids.includes(entry.recipeId)) {
        ids.push(entry.recipeId);
      }
    }
  }

  // port：可选数字（1-65535），字符串数字也收（CLI flag 总是字符串）
  if (source.port !== undefined && source.port !== null && source.port !== '') {
    const port = typeof source.port === 'number' ? source.port : Number(String(source.port).trim());
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return fail(`env 字段 "port" 必须是 1-65535 的整数（收到：${JSON.stringify(source.port)}）`);
    }
    entry.port = port;
  }

  // 'local' 是内置条目、不经 add 流程（kind 检查已拦在前）——此处只列
  // 可登记 kind 的必填字段。
  type RegisterableKind = Exclude<EnvironmentKind, 'local'>;
  const requiredByKind: Record<RegisterableKind, keyof EnvironmentEntryInput> = {
    ssh: 'host',
    docker: 'container',
    vm: 'vmName',
  };
  const required = requiredByKind[entry.kind as RegisterableKind];
  if (!entry[required]) {
    return fail(`kind=${entry.kind} 缺少必填字段：${required}（--${required.toLowerCase()}）`);
  }

  return { ok: true, entry };
}

/** config.json read helper: legacy configs have no `environments` field. */
export function listEnvironments(config: {
  environments?: EnvironmentEntry[];
  [key: string]: unknown;
}): EnvironmentEntry[] {
  return Array.isArray(config.environments) ? config.environments : [];
}

export function findEnvironmentEntry(
  list: readonly EnvironmentEntry[] | undefined,
  id: string,
): EnvironmentEntry | undefined {
  return (list ?? []).find((e) => e.id === id);
}

/** Append with id-uniqueness enforcement. Does not mutate the input list. */
export function addEnvironmentEntry(
  list: readonly EnvironmentEntry[] | undefined,
  entry: EnvironmentEntry,
): EnvResult<{ entries: EnvironmentEntry[] }> {
  const entries = [...(list ?? [])];
  if (entries.some((e) => e.id === entry.id)) {
    return fail(`环境 id "${entry.id}" 已存在（zhishi env remove ${entry.id} 后可重加）`);
  }
  entries.push(entry);
  return { ok: true, entries };
}

/** Remove by id. Does not mutate the input list. */
export function removeEnvironmentEntry(
  list: readonly EnvironmentEntry[] | undefined,
  id: string,
): EnvResult<{ entries: EnvironmentEntry[]; removed: EnvironmentEntry }> {
  const entries = list ?? [];
  const target = findEnvironmentEntry(entries, id);
  if (!target) {
    return fail(`未找到环境 "${id}"（zhishi env list 查看已有环境）`);
  }
  return { ok: true, entries: entries.filter((e) => e.id !== id), removed: target };
}

/**
 * 1.6.6：改名（别名）——只动 `name`（显示名），id 是身份（env-sessions /
 * selection / 会话锚全挂 id）绝不改。name 置空 = 清除别名（回显 id）。
 * Does not mutate the input list.
 */
export function renameEnvironmentEntry(
  list: readonly EnvironmentEntry[] | undefined,
  id: string,
  name: string,
): EnvResult<{ entries: EnvironmentEntry[] }> {
  const entries = list ?? [];
  if (!findEnvironmentEntry(entries, id)) {
    return fail(`未找到环境 "${id}"（zhishi env list 查看已有环境）`);
  }
  const trimmed = name.trim();
  return {
    ok: true,
    entries: entries.map((e) => {
      if (e.id !== id) return e;
      const next = { ...e };
      if (trimmed) next.name = trimmed;
      else delete next.name;
      return next;
    }),
  };
}

/** Quote one argument when it contains whitespace or quotes. */
function quoteArg(value: string): string {
  return /[\s"']/.test(value) ? JSON.stringify(value) : value;
}

/** `ssh [-p port] [-i keyPath] [user@]target` — shared by kind=ssh and vm-with-address. */
function buildSshCommand(target: string, user?: string, keyPath?: string, port?: number): string {
  const parts = ['ssh'];
  if (port !== undefined) parts.push('-p', String(port));
  if (keyPath) parts.push('-i', quoteArg(keyPath));
  parts.push(quoteArg(user ? `${user}@${target}` : target));
  return parts.join(' ');
}

/**
 * D14 边界标记（P1 E6）：条目 → term 会话 envTag。
 *   docker → docker:<container>
 *   vm     → vm:<vmName>
 *   ssh    → range:<host>
 *   local  → local（宿主即环境）
 * 宿主终端无标记（等同 'host'）。标记经 `term open --env` 落到 Rust
 * TerminalManager。字段缺省时兜底 entry.id（validate 已保证按 kind 必填，
 * 兜底只为防御）。
 */
export function envTagForEntry(entry: EnvironmentEntry): string {
  switch (entry.kind) {
    case 'docker':
      return `docker:${entry.container ?? entry.id}`;
    case 'vm':
      return `vm:${entry.vmName ?? entry.id}`;
    case 'ssh':
      return `range:${entry.host ?? entry.id}`;
    case 'local':
      return 'local';
  }
}

/**
 * Resolve an entry to the command string that `zhishi env open` feeds into
 * `term open --cmd`:
 *   ssh    → ssh [-i keyPath] [user@]host（不带远端命令——尊重远端默认 shell：
 *            Windows OpenSSH 默认 cmd.exe，管理员可能已配 powershell）
 *   docker → docker exec -it <container> <shell>（shell 按 osFamily：windows
 *            容器没有 bash，给 cmd.exe）
 *   vm     → address ? ssh [-i keyPath] [user@]address（同 ssh 的默认 shell 纪律）
 *            : error（指向 env exec 的 guest-exec 通道）
 *   local  → cmd.exe（宿主 PTY——交互式 WinDbg/cdb 会话的落点，design §2）
 */
export function resolveEnvOpenCommand(entry: EnvironmentEntry): EnvResult<{ cmd: string }> {
  switch (entry.kind) {
    case 'local':
      return { ok: true, cmd: 'cmd.exe' };
    case 'ssh':
      return { ok: true, cmd: buildSshCommand(entry.host!, entry.user, entry.keyPath, entry.port) };
    case 'docker': {
      // 1.6.4：osFamily 消费——windows 容器（nanoserver/windowsservercore 系）
      // 只有 cmd.exe（powershell 都未必有），硬写 bash 必炸。
      const shell = osFamilyOf(entry) === 'windows' ? 'cmd.exe' : 'bash';
      return { ok: true, cmd: `docker exec -it ${quoteArg(entry.container!)} ${shell}` };
    }
    case 'vm':
      if (entry.address) {
        return { ok: true, cmd: buildSshCommand(entry.address, entry.user, entry.keyPath, entry.port) };
      }
      return fail(
        `环境 "${entry.id}"（VM: ${entry.vmName ?? '?'}）未配置 address——` +
        `断网隔离 VM 的一次性命令走 hypervisor guest-exec 通道：zhishi env exec ${entry.id} -- <command...>；` +
        '若 VM 已有网络，先补 address（zhishi env remove 后重加）',
      );
  }
}
