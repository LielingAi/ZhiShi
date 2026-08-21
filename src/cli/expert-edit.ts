/**
 * 专家知识层（1.2.1 骨架期）—— CLI 编辑器往返（crontab -e 模式）的编辑部逻辑。
 *
 * 条目文件格式契约：frontmatter（domain/kind/title/applicability/criteria/
 * reviewer/tags）+ markdown 正文（= content）。解析复用 SKILL.md 同款机制
 * （extractFrontmatter + js-yaml）；校验直接调服务端单点 validateEntry
 * （由调用方组装入参）——CLI 与服务端错误口径一致。
 *
 * 纪律（铁律）：
 * - 编辑器是外部进程：execFileSync 直起（不经 shell，无转义面）；
 * - 退出码非零 / 文件未动 → 不落库（调用方拿不到 ok 就不会发 API）；
 * - 中断（SIGINT）/ 任何异常路径都清理临时文件（try/finally + once handler）。
 *
 * 依赖注入：runEditor / confirmRetry / env / tmpDir / log 全部可替换，
 * 纯函数部分（模板生成 / 解析 / 重试决策）不碰 IO，可单测。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dump as yamlDump, load as yamlLoad } from 'js-yaml';

import { extractFrontmatter } from '../shared/slashCommands';
import { EXPERT_ENTRY_KINDS } from '../server/expert/validate';
import { RESEARCH_TASK_KINDS } from '../server/memory/store';

// ---------------------------------------------------------------------------
// 文件格式：序列化 / 解析（纯函数）
// ---------------------------------------------------------------------------

/** 编辑器文件里 frontmatter 承载的字段（正文 = content，不在 frontmatter）。 */
export interface ExpertDocFields {
  domain?: unknown;
  kind?: unknown;
  title?: unknown;
  applicability?: unknown;
  criteria?: unknown;
  reviewer?: unknown;
  tags?: unknown;
}

export type ExpertDocParseResult =
  | { ok: true; fields: ExpertDocFields; content: string }
  | { ok: false; errors: string[] };

/** 单个字段的 YAML 行：借 yamlDump 保证任意字符串的引号/转义正确。 */
function yamlFieldLine(key: string, value: string): string {
  return yamlDump({ [key]: value }, { lineWidth: -1 }).trimEnd();
}

/**
 * 生成编辑器文件的初始内容：frontmatter 全字段注释引导（闭集枚举、必填
 * 语义写在注释里）+ 正文。未提供的字段给空串占位——保存原样即校验失败
 * （必填非空），配合「文件未动不落库」构成放弃语义。
 */
export function buildExpertDoc(fields: {
  domain?: string;
  kind?: string;
  title?: string;
  applicability?: string;
  criteria?: string;
  reviewer?: string;
  tags?: string;
}, content: string): string {
  const fm = [
    `# 专家知识条目（frontmatter + 正文）。保存并关闭编辑器后自动校验；`,
    `# 非法会列出全部错误并可重新编辑；不做任何修改直接关闭 = 放弃。`,
    `# domain 必填，闭集：${RESEARCH_TASK_KINDS.join(' / ')}`,
    yamlFieldLine('domain', fields.domain ?? ''),
    `# kind 必填，闭集：${EXPERT_ENTRY_KINDS.join(' / ')}（idea=思路 technique=技术知识 sop=标准作业流程）`,
    yamlFieldLine('kind', fields.kind ?? ''),
    `# title 必填非空`,
    yamlFieldLine('title', fields.title ?? ''),
    `# applicability 必填非空：适用条件——什么时候该用它`,
    yamlFieldLine('applicability', fields.applicability ?? ''),
    `# criteria 必填非空：判据——怎么验证用对了（校准闭环的关键）`,
    yamlFieldLine('criteria', fields.criteria ?? ''),
    `# reviewer 必填非空：审定人（权威性的来源是人审这个动作）`,
    yamlFieldLine('reviewer', fields.reviewer ?? ''),
    `# tags 可选：逗号分隔`,
    yamlFieldLine('tags', fields.tags ?? ''),
  ].join('\n');
  const body = content.trim().length > 0 ? content.trimEnd() : '（在此写正文：markdown 自由结构——怎么做、为什么有效）';
  return `---\n${fm}\n---\n\n${body}\n`;
}

/**
 * 解析编辑器文件：frontmatter 必须在文件头（extractFrontmatter 同款契约），
 * YAML 必须是对象；字段值原样透传（类型交给 validateEntry 判），正文归一
 * 为 LF 后作为 content。
 */
export function parseExpertDoc(raw: string): ExpertDocParseResult {
  const normalized = raw.replace(/\r\n/g, '\n');
  const extracted = extractFrontmatter(normalized);
  if (!extracted) {
    return { ok: false, errors: ['缺少 frontmatter：文件必须以 --- 开头、以第二个 --- 结束头部'] };
  }
  let parsed: unknown;
  try {
    parsed = yamlLoad(extracted.frontmatterStr);
  } catch (err) {
    return { ok: false, errors: [`frontmatter YAML 解析失败：${err instanceof Error ? err.message : String(err)}`] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, errors: ['frontmatter 必须是 YAML 对象（key: value 形式）'] };
  }
  const fm = parsed as Record<string, unknown>;
  return {
    ok: true,
    fields: {
      domain: fm.domain,
      kind: fm.kind,
      title: fm.title,
      applicability: fm.applicability,
      criteria: fm.criteria,
      reviewer: fm.reviewer,
      tags: fm.tags,
    },
    content: extracted.body,
  };
}

// ---------------------------------------------------------------------------
// 编辑器外部进程
// ---------------------------------------------------------------------------

/**
 * 解析编辑器命令：$EDITOR ?? $VISUAL ??（win32 ? notepad : vi）。
 * 返回值是 argv（按空白切分）——支持 "code --wait" 这类带参数写法；
 * execFileSync 直起第一个 token，不经 shell，无转义面。
 */
export function resolveEditorCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const editor = (env.EDITOR ?? '').trim() || (env.VISUAL ?? '').trim();
  const cmd = editor || (platform === 'win32' ? 'notepad' : 'vi');
  return cmd.split(/\s+/).filter((t) => t.length > 0);
}

export interface EditorRunResult {
  /** 进程退出码；启动失败（ENOENT 等）时归一为 1 并带 spawnError。 */
  code: number;
  /** 启动失败（编辑器不存在/不可执行）——重试无意义，直接放弃。 */
  spawnError?: string;
}

export type EditorRunner = (argv: string[], filePath: string) => EditorRunResult;

/** 真实编辑器执行：execFileSync + stdio 继承（用户在自己的终端里编辑）。 */
export const defaultEditorRunner: EditorRunner = (argv, filePath) => {
  try {
    execFileSync(argv[0], [...argv.slice(1), filePath], { stdio: 'inherit' });
    return { code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { status?: number | null };
    if (typeof e.status === 'number') return { code: e.status };
    // status 为 null：启动失败或被信号杀死——都按不可重试处理。
    return { code: 1, spawnError: e.message };
  }
};

// ---------------------------------------------------------------------------
// 编辑器往返循环
// ---------------------------------------------------------------------------

export interface ExpertEditorDeps {
  runEditor?: EditorRunner;
  /** 校验失败/退出码非零后的「重新编辑？」决策；返回 false = 放弃。 */
  confirmRetry?: (errors: string[]) => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  tmpDir?: string;
  log?: (msg: string) => void;
}

export type ExpertEditOutcome =
  | { status: 'ok'; raw: string }
  | { status: 'aborted'; reason: string };

let tmpFileCounter = 0;

/**
 * 编辑器往返：写临时文件 → 开编辑器 → 读回校验 → 非法列错误重开，
 * 直到合法（ok）或放弃（aborted）。文件未动 / 退出码非零 / 启动失败
 * 一律不给 ok——调用方只在 ok 时才发写库 API。临时文件在任何出口
 * （含 SIGINT）都清理。
 */
export async function expertEditRoundTrip(
  initialContent: string,
  validate: (raw: string) => { ok: true } | { ok: false; errors: string[] },
  deps: ExpertEditorDeps = {},
): Promise<ExpertEditOutcome> {
  const runEditor = deps.runEditor ?? defaultEditorRunner;
  const confirmRetry = deps.confirmRetry ?? (async () => false);
  const log = deps.log ?? ((msg: string) => console.error(msg));
  const argv = resolveEditorCommand(deps.env ?? process.env);
  if (argv.length === 0) {
    return { status: 'aborted', reason: '未配置编辑器：设 EDITOR 环境变量（Windows 缺省 notepad）' };
  }

  const dir = deps.tmpDir ?? mkdtempSync(join(tmpdir(), 'zhishi-expert-'));
  tmpFileCounter += 1;
  const filePath = join(dir, `zhishi-expert-${process.pid}-${tmpFileCounter}.md`);
  const cleanup = () => {
    try {
      if (deps.tmpDir) rmSync(filePath, { force: true });
      else rmSync(dir, { recursive: true, force: true });
    } catch { /* 清理失败不遮主流程 */ }
  };
  const onSigint = () => {
    cleanup();
    process.exit(130);
  };
  process.once('SIGINT', onSigint);

  try {
    let current = initialContent;
    for (;;) {
      writeFileSync(filePath, current, 'utf-8');
      const run = runEditor(argv, filePath);
      if (run.spawnError !== undefined) {
        return {
          status: 'aborted',
          reason: `编辑器启动失败（${argv.join(' ')}）：${run.spawnError}——设 EDITOR 环境变量后重试`,
        };
      }
      if (run.code !== 0) {
        log(`编辑器退出码非零（${run.code}）——未写入任何变更。`);
        if (!(await confirmRetry([`编辑器（${argv.join(' ')}）退出码 ${run.code}，文件未落库`]))) {
          return { status: 'aborted', reason: '编辑器退出码非零，放弃' };
        }
        continue;
      }
      const raw = readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n');
      if (raw === current) {
        return { status: 'aborted', reason: '文件未修改——未写入任何变更' };
      }
      const verdict = validate(raw);
      if (verdict.ok) return { status: 'ok', raw };
      log('条目校验未通过：');
      for (const e of verdict.errors) log(`  - ${e}`);
      if (!(await confirmRetry(verdict.errors))) {
        return { status: 'aborted', reason: '校验未通过，放弃' };
      }
      current = raw; // 重开带用户已编辑内容，不丢稿
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
    cleanup();
  }
}
