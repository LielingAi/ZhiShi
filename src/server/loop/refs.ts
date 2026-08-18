/**
 * W1(design-spec §6.4 「@ = 名词」)— /chat/send 的 refs 注入解析。
 *
 * payload 加可选 refs 数组(additive,不破契约):
 *   { type:'file', path }      环境内文件 → 内容(小全量;大给头 100 行 +
 *                              尾 50 行 + 行数标注),经 env 通道(env_exec 同
 *                              一条 ssh 通道)读取
 *   { type:'env', id }         环境元数据(基底/地址/凭据引用/运行状态)
 *   { type:'snapshot', name }  快照元数据(vm:vmrun listSnapshots 核实存在性;
 *                              docker:注明暂未支持)
 *   { type:'taskmd' }          环境内 task.md 内容(无则注明)
 *
 * 解析结果作为 grounding 段前置进用户消息,格式:
 *   <context ref="file:/work/exp.py">…</context>
 * 单项解析失败只在该项的 context 块里注明,不阻塞其余项与发送本身。
 *
 * 通道纪律:file/taskmd 走 execInEnvironment(与 env_exec 同一实现,凭据只
 * 用 keyPath);snapshot/运行状态走 vmrun(exec 注入化,单测绝不真碰 ssh/
 * vmrun)。
 */

import type { EnvironmentEntry } from '../../shared/config-types';
import {
  buildVmrunListArgs,
  buildVmrunListSnapshotsArgs,
  defaultVmrunExec,
  normalizeVmxPath,
  parseVmrunList,
  parseVmrunSnapshotList,
  VMRUN_LIST_TIMEOUT_MS,
  type VmExec,
} from '../environment/vm-lifecycle';
import {
  execInEnvironment,
  type EnvExec,
} from './env-exec';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChatRef =
  | { type: 'file'; path: string }
  | { type: 'env'; id: string }
  | { type: 'snapshot'; name: string }
  | { type: 'taskmd' };

export interface ParsedRefs {
  refs: ChatRef[];
  /** 形状非法的条目原文摘要(解析成失败 context 块,不阻塞)。 */
  invalid: string[];
}

export interface ResolveRefsContext {
  /** 当前锚定环境(file/taskmd/snapshot 的目标;env ref 按 id 查 environments)。 */
  env: EnvironmentEntry | null;
  /** 登记环境全集(env ref 解析)。 */
  environments: EnvironmentEntry[];
  /** 测试注入:env 通道(默认 defaultEnvExec 经 execInEnvironment)。 */
  envExec?: EnvExec;
  /** 测试注入:vmrun 通道。 */
  vmExec?: VmExec;
}

/** 小文件阈值:≤150 行全量;超出给头 100 + 尾 50。 */
export const REF_FILE_FULL_LINES = 150;
export const REF_FILE_HEAD_LINES = 100;
export const REF_FILE_TAIL_LINES = 50;

// ---------------------------------------------------------------------------
// parse(宽容:坏条目进 invalid,不 throw)
// ---------------------------------------------------------------------------

export function parseChatRefs(raw: unknown): ParsedRefs {
  const refs: ChatRef[] = [];
  const invalid: string[] = [];
  if (raw === undefined || raw === null) return { refs, invalid };
  if (!Array.isArray(raw)) return { refs, invalid: ['refs 必须是数组'] };
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      invalid.push(`非法 ref 条目:${JSON.stringify(item)?.slice(0, 80)}`);
      continue;
    }
    const rec = item as Record<string, unknown>;
    if (rec.type === 'file' && typeof rec.path === 'string' && rec.path.trim()) {
      refs.push({ type: 'file', path: rec.path.trim() });
    } else if (rec.type === 'env' && typeof rec.id === 'string' && rec.id.trim()) {
      refs.push({ type: 'env', id: rec.id.trim() });
    } else if (rec.type === 'snapshot' && typeof rec.name === 'string' && rec.name.trim()) {
      refs.push({ type: 'snapshot', name: rec.name.trim() });
    } else if (rec.type === 'taskmd') {
      refs.push({ type: 'taskmd' });
    } else {
      invalid.push(`非法 ref 条目:${JSON.stringify(item)?.slice(0, 80)}`);
    }
  }
  return { refs, invalid };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** POSIX sh 单引号转义(' → '\'')。 */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function contextBlock(refLabel: string, body: string): string {
  return `<context ref="${refLabel}">\n${body}\n</context>`;
}

function failureBlock(refLabel: string, reason: string): string {
  return contextBlock(refLabel, `[解析失败:${reason}]`);
}

// ---------------------------------------------------------------------------
// 单项解析
// ---------------------------------------------------------------------------

const NOT_FOUND = '__ZHISHI_NOT_FOUND__';
const TOTAL_MARK = '__ZHISHI_TOTAL__=';
const OMITTED_MARK = '__ZHISHI_OMITTED__';
const PATH_MARK = '__ZHISHI_PATH__=';

/**
 * 环境内文件读取:一条远端命令完成 存在性 + 行数 + (全量 | 头+尾)。
 * 输出协议:首行 __ZHISHI_TOTAL__=N,随后内容;大文件中间插一行
 * __ZHISHI_OMITTED__ 分隔头 100 行与尾 50 行。
 */
export function buildReadFileCommand(path: string): string {
  const p = shQuote(path);
  return [
    `p=${p}`,
    `if [ ! -f "$p" ]; then echo ${NOT_FOUND}; exit 0; fi`,
    `total=$(wc -l < "$p" | tr -d ' ')`,
    `echo "${TOTAL_MARK}$total"`,
    `if [ "$total" -le ${REF_FILE_FULL_LINES} ]; then cat -- "$p"`,
    `else head -n ${REF_FILE_HEAD_LINES} -- "$p"; echo ${OMITTED_MARK}; tail -n ${REF_FILE_TAIL_LINES} -- "$p"; fi`,
  ].join('\n');
}

/** task.md 探测序列:$HOME/task.md → ./task.md → /work/task.md。 */
export function buildReadTaskmdCommand(): string {
  return [
    'for p in "$HOME/task.md" "./task.md" "/work/task.md"; do',
    `if [ -f "$p" ]; then echo "${PATH_MARK}$p"; cat -- "$p"; exit 0; fi`,
    'done',
    `echo ${NOT_FOUND}`,
  ].join('\n');
}

async function runEnvCommand(
  ctx: ResolveRefsContext,
  command: string,
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  if (!ctx.env) return { ok: false, error: '当前未锚定环境,无法读环境内对象' };
  const result = await execInEnvironment(ctx.env, command, { exec: ctx.envExec });
  if (!result.ok) return { ok: false, error: result.error };
  if (result.exitCode !== 0) {
    return { ok: false, error: `远端命令退出码 ${result.exitCode}:${result.stderr.trim().slice(0, 200)}` };
  }
  return { ok: true, stdout: result.stdout };
}

async function resolveFileRef(ctx: ResolveRefsContext, path: string): Promise<string> {
  const label = `file:${path}`;
  const r = await runEnvCommand(ctx, buildReadFileCommand(path));
  if (!r.ok) return failureBlock(label, r.error);
  const stdout = r.stdout;
  if (stdout.includes(NOT_FOUND)) {
    return contextBlock(label, `[环境 ${ctx.env!.id} 内不存在该文件]`);
  }
  const totalMatch = stdout.match(/^__ZHISHI_TOTAL__=(\d+)/m);
  const total = totalMatch ? Number(totalMatch[1]) : null;
  const bodyStart = stdout.indexOf('\n') + 1;
  const body = bodyStart > 0 ? stdout.slice(bodyStart) : stdout;
  if (body.includes(`\n${OMITTED_MARK}\n`) || body.startsWith(`${OMITTED_MARK}\n`) || body.includes(OMITTED_MARK)) {
    const [head, tail] = body.split(OMITTED_MARK);
    const omitted = total !== null ? Math.max(0, total - REF_FILE_HEAD_LINES - REF_FILE_TAIL_LINES) : null;
    const annotation = omitted !== null
      ? `[…… 中间省略约 ${omitted} 行(共 ${total} 行,已显示头 ${REF_FILE_HEAD_LINES} 行 + 尾 ${REF_FILE_TAIL_LINES} 行)……]`
      : '[…… 中间省略部分行 ……]';
    return contextBlock(
      label,
      `[环境 ${ctx.env!.id} 内文件,共 ${total ?? '?'} 行,以下为头 ${REF_FILE_HEAD_LINES} 行 + 尾 ${REF_FILE_TAIL_LINES} 行]\n` +
        `${head.trimEnd()}\n${annotation}\n${tail.trim()}`,
    );
  }
  return contextBlock(
    label,
    `[环境 ${ctx.env!.id} 内文件,共 ${total ?? '?'} 行,以下为完整内容]\n${body.trimEnd()}`,
  );
}

async function resolveTaskmdRef(ctx: ResolveRefsContext): Promise<string> {
  const label = 'taskmd';
  const r = await runEnvCommand(ctx, buildReadTaskmdCommand());
  if (!r.ok) return failureBlock(label, r.error);
  if (r.stdout.includes(NOT_FOUND)) {
    return contextBlock(label, `[环境 ${ctx.env!.id} 内未找到 task.md(已查 $HOME/task.md、./task.md、/work/task.md)]`);
  }
  const nl = r.stdout.indexOf('\n');
  const firstLine = nl >= 0 ? r.stdout.slice(0, nl) : r.stdout;
  const foundPath = firstLine.startsWith(PATH_MARK) ? firstLine.slice(PATH_MARK.length) : 'task.md';
  const body = nl >= 0 ? r.stdout.slice(nl + 1) : '';
  return contextBlock(label, `[环境 ${ctx.env!.id} 内 ${foundPath} 的内容]\n${body.trimEnd()}`);
}

/** 运行状态探测:vm+vmx → vmrun list;其余 → 未知(不探测,零成本)。 */
async function probeEnvState(ctx: ResolveRefsContext, entry: EnvironmentEntry): Promise<string> {
  if (entry.kind === 'vm' && entry.vmx) {
    const exec = ctx.vmExec ?? defaultVmrunExec;
    try {
      const r = await exec(['vmrun', ...buildVmrunListArgs()], VMRUN_LIST_TIMEOUT_MS);
      if (r.exitCode === 0 && !r.error) {
        const running = parseVmrunList(r.stdout).some(
          (p) => normalizeVmxPath(p) === normalizeVmxPath(entry.vmx!),
        );
        return running ? 'running' : 'stopped';
      }
      return `未知(vmrun list 失败:${(r.error || r.stderr).slice(0, 120)})`;
    } catch (err) {
      return `未知(${err instanceof Error ? err.message : String(err)})`;
    }
  }
  return '未知(未探测)';
}

async function resolveEnvRef(ctx: ResolveRefsContext, id: string): Promise<string> {
  const label = `env:${id}`;
  const entry = ctx.environments.find((e) => e.id === id);
  if (!entry) return failureBlock(label, `登记环境里不存在 id="${id}"`);
  const state = await probeEnvState(ctx, entry);
  const locator = entry.address ?? entry.host ?? entry.container ?? entry.vmx ?? entry.vmName ?? '';
  const lines = [
    `id: ${entry.id}`,
    `kind: ${entry.kind}`,
    entry.name ? `name: ${entry.name}` : '',
    locator ? `地址/定位: ${locator}` : '',
    entry.port ? `port: ${entry.port}` : '',
    entry.user ? `user: ${entry.user}` : '',
    entry.keyPath ? `keyPath(引用,非凭据本体): ${entry.keyPath}` : '',
    `运行状态: ${state}`,
    entry.createdAt ? `createdAt: ${entry.createdAt}` : '',
  ].filter(Boolean);
  return contextBlock(label, `[环境元数据]\n${lines.join('\n')}`);
}

async function resolveSnapshotRef(ctx: ResolveRefsContext, name: string): Promise<string> {
  const label = `snapshot:${name}`;
  if (!ctx.env) return failureBlock(label, '当前未锚定环境,无法定位快照所属 VM');
  const entry = ctx.env;
  if (entry.kind === 'docker') {
    return contextBlock(label, `[docker 环境快照暂未支持(名称:${name})]`);
  }
  if (entry.kind !== 'vm' || !entry.vmx) {
    return failureBlock(label, `环境 "${entry.id}" 不是带 vmx 定位的 VM 条目,无法查快照`);
  }
  const exec = ctx.vmExec ?? defaultVmrunExec;
  try {
    const r = await exec(['vmrun', ...buildVmrunListSnapshotsArgs(entry.vmx)], VMRUN_LIST_TIMEOUT_MS);
    if (r.exitCode !== 0 || r.error) {
      return failureBlock(label, `vmrun listSnapshots 失败:${(r.error || r.stderr).slice(0, 200)}`);
    }
    const snapshots = parseVmrunSnapshotList(r.stdout);
    const exists = snapshots.includes(name);
    return contextBlock(
      label,
      `[快照元数据]\n名称: ${name}\n环境: ${entry.id}\nvmx: ${entry.vmx}\n` +
        `存在性: ${exists ? '存在' : '不存在(可用 /snapshot 先留现场)'}\n` +
        `该 VM 全部快照: ${snapshots.length > 0 ? snapshots.join(', ') : '(无)'}`,
    );
  } catch (err) {
    return failureBlock(label, err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// 入口:refs → grounding 段(前置进用户消息)
// ---------------------------------------------------------------------------

/**
 * 解析全部 refs,返回 grounding 文本(若干 <context> 块,以空行分隔)。
 * 无 refs 且无非法条目 → 空串(调用方原样发送)。单项失败不阻塞。
 */
export async function resolveChatRefs(parsed: ParsedRefs, ctx: ResolveRefsContext): Promise<string> {
  const blocks: string[] = [];
  for (const note of parsed.invalid) {
    blocks.push(contextBlock('invalid', `[解析失败:${note}]`));
  }
  for (const ref of parsed.refs) {
    try {
      if (ref.type === 'file') blocks.push(await resolveFileRef(ctx, ref.path));
      else if (ref.type === 'env') blocks.push(await resolveEnvRef(ctx, ref.id));
      else if (ref.type === 'snapshot') blocks.push(await resolveSnapshotRef(ctx, ref.name));
      else blocks.push(await resolveTaskmdRef(ctx));
    } catch (err) {
      const label = ref.type === 'taskmd' ? 'taskmd' : `${ref.type}:${(ref as { path?: string; id?: string; name?: string }).path ?? (ref as { id?: string }).id ?? (ref as { name?: string }).name}`;
      blocks.push(failureBlock(label, err instanceof Error ? err.message : String(err)));
    }
  }
  return blocks.join('\n\n');
}
