#!/usr/bin/env node
/**
 * zhishi-trajectory-export.mts — 数据准备工具（离线，非运行时；不进 tsconfig include，
 * 不 import 任何 src/ 运行时模块）。
 *
 * 目标：把 ZhiShi 的 loop-session 轨迹（~/.zhishi/loop-sessions/<id>.jsonl）转换成
 * Claude Code sdk-cli 的 raw session log 格式（训练流水线的输入格式），并在切分点
 * 制造 `system/compact_boundary` + `isCompactSummary` 两条记录，使产物在形状上与
 * 模板 `E:/trajectory.raw.jsonl` 对齐，便于并排比对。
 *
 * 输入（ZhiShi，只读）：
 *   {"kind":"meta",model,providerId,createdAt,updatedAt,tokenCalibration?}
 *   {"kind":"system-prompt",hash,content,at,pos}                       （可选，当前文件没有）
 *   {role:'user',content:string,timestamp:number}
 *   {role:'assistant',content:[{type:'thinking',thinking,thinkingSignature?}
 *                             |{type:'text',text}
 *                             |{type:'toolCall',id,name,arguments}], ...}
 *   {role:'toolResult',toolCallId,toolName,content:[{type:'text',text}],details?,isError?,timestamp:number}
 *
 * 输出（Claude Code raw session log，每行一个 JSON 对象）：
 *   queue-operation / user / assistant / system(compact_boundary)
 *   每个 assistant 内容块独占一行（与模板一致：462 assistant 行 = 462 个块）。
 *
 * 用法：
 *   npx tsx scripts/zhishi-trajectory-export.mts
 *   npx tsx scripts/zhishi-trajectory-export.mts --dry-run          # 不调 LLM，用机械兜底摘要
 *   npx tsx scripts/zhishi-trajectory-export.mts --window 200000 --ratio 0.85 --model deepseek-flash
 *
 * 约束：对 ~/.zhishi/loop-sessions/ 只读；只写 --out / --report 指定的路径；永不打印密钥。
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 常量 / 默认值
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

/**
 * 数据目录解析：**只认两个来源**——`--data-dir <path>` 与 `$ZHISHI_DATA_DIR`，
 * 都没有才回落 `~/.zhishi`。
 *
 * 刻意不复制产品侧的三级链（`src/shared/app-dirs.ts`：`ZHISHI_DATA_DIR` →
 * `ZHISHI_CONFIG_DIR`(legacy) → `~/.zhishi`）：抄一份就会漂，而 legacy 那一级
 * 对「数据准备工具」没有意义。口径要变时，这里是一处显式改动，不是第 N 份抄本。
 *
 * 为什么要这个开关：团队大脑跑在 `ZHISHI_DATA_DIR=~/.zhishi-brain` 这类目录下，
 * 硬编码 `~/.zhishi` 会在脑机上一条线都找不到。
 */
function resolveDataDir(argv: string[]): string {
  const i = argv.indexOf('--data-dir');
  const explicit = i >= 0 ? argv[i + 1] : undefined;
  if (explicit) return resolve(explicit);
  const envDir = process.env.ZHISHI_DATA_DIR;
  if (envDir) return resolve(envDir);
  return join(homedir(), '.zhishi');
}

const DEFAULT_OUT = 'E:/trajectory.from-zhishi.jsonl';
const DEFAULT_REPORT = 'E:/trajectory.from-zhishi.report.md';
const DEFAULT_TEMPLATE = 'E:/trajectory.raw.jsonl';

/** 「哪些文件是线」的契约（与产品持久化层同口径）：
 *  - 线 = `loop-sessions/<sessionId>.jsonl`（packages/zhishi-loop-core 的会话持久化）；
 *  - 同目录并存的 `<id>.archive.json`（`src/server/loop/archive.ts:131-138` 的
 *    `archiveFile()`）与 tmp+rename 的中间文件都不是线——按 `.jsonl` 后缀筛即可
 *    排除，另有「缺 meta 行即不是线」的兜底（进 manifest 的 skipped）。 */
function isLineFile(name: string): boolean {
  return name.toLowerCase().endsWith('.jsonl');
}

const ENTRYPOINT = 'zhishi';
const USER_TYPE = 'external';
/** 模板里 196 条 user 行共用同一个 promptId（SDK 单提示会话），此处照搬。 */
const PROMPT_ID = randomUUID();
/** 模板只在首条 user 行上带 permissionMode。 */
const PERMISSION_MODE = 'bypassPermissions';

const COMPACT_PREAMBLE =
  'This session is being continued from a previous conversation that ran out of context. ' +
  'The summary below covers the earlier portion of the conversation.\n\nSummary:\n';
const COMPACT_TRAILER =
  '\n\nContinue the conversation from where it left off without asking the user any further questions. ' +
  'Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface ' +
  'with "I\'ll continue" or similar. Pick up the last task as if the break never happened.';

/** 模板 9 段的段名（顺序即契约）。 */
const SUMMARY_SECTIONS = [
  'Primary Request and Intent',
  'Key Technical Concepts',
  'Files and Code Sections',
  'Errors and fixes',
  'Problem Solving',
  'All user messages',
  'Pending Tasks',
  'Current Work',
  'Optional Next Step',
] as const;

const FALLBACK_MARK = '[MECHANICAL FALLBACK — 本摘要未经 LLM 生成，为脚本机械兜底占位]';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Options {
  /** 数据目录（`--data-dir` / `$ZHISHI_DATA_DIR` / `~/.zhishi`）——单线缺省与 config/env-sessions 都按它算。 */
  dataDir: string;
  input: string;
  out: string;
  report: string;
  manifest: string;
  template: string;
  config: string;
  envSessions: string;
  window: number;
  ratio: number;
  model: string;
  baseUrl: string;
  heuristic: 'cjk' | 'pi';
  summaryMaxTokens: number;
  maxOutputTokens: number;
  timeoutMs: number;
  dryRun: boolean;
  gitBranch: string;
  summaries: string;
  /** 批量模式上限（只导出前 N 条线；缺省不限）。 */
  limit?: number;
}

function parseArgs(argv: string[], dataDir: string): Options {
  const o: Options = {
    dataDir,
    input: join(dataDir, 'loop-sessions', 'munmye6v-70a398b7150c.jsonl'),
    out: DEFAULT_OUT,
    report: DEFAULT_REPORT,
    manifest: '',
    template: DEFAULT_TEMPLATE,
    config: join(dataDir, 'config.json'),
    envSessions: join(dataDir, 'env-sessions.json'),
    window: 256_000,
    ratio: 0.85,
    model: 'deepseek-flash',
    baseUrl: 'https://api.deepseek.com/v1',
    // 仓库 context-manager 的实际口径是 CJK 分档校准；'pi' = 裸 chars/4。
    heuristic: 'cjk',
    summaryMaxTokens: 90_000,
    maxOutputTokens: 16_000,
    timeoutMs: 600_000,
    dryRun: false,
    gitBranch: '',
    summaries: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`缺少参数值: ${a}`);
      return v;
    };
    switch (a) {
      case '--input': o.input = next(); break;
      case '--out': o.out = next(); break;
      case '--report': o.report = next(); break;
      case '--manifest': o.manifest = next(); break;
      // 已在 resolveDataDir 生效（缺省值都按它算）——这里只为「参数认识它」并吞掉值。
      case '--data-dir': next(); break;
      case '--limit': o.limit = Number(next()); break;
      case '--template': o.template = next(); break;
      case '--config': o.config = next(); break;
      case '--env-sessions': o.envSessions = next(); break;
      case '--window': o.window = Number(next()); break;
      case '--ratio': o.ratio = Number(next()); break;
      case '--model': o.model = next(); break;
      case '--base-url': o.baseUrl = next(); break;
      case '--heuristic': o.heuristic = next() === 'pi' ? 'pi' : 'cjk'; break;
      case '--summary-max-tokens': o.summaryMaxTokens = Number(next()); break;
      case '--max-output-tokens': o.maxOutputTokens = Number(next()); break;
      case '--timeout-ms': o.timeoutMs = Number(next()); break;
      case '--git-branch': o.gitBranch = next(); break;
      case '--summaries': o.summaries = next(); break;
      case '--dry-run': o.dryRun = true; break;
      case '-h':
      case '--help': printHelp(); process.exit(0); break;
      default: throw new Error(`未知参数: ${a}`);
    }
  }
  return o;
}

function printHelp(): void {
  process.stdout.write(
    [
      'zhishi-trajectory-export — ZhiShi loop-session 轨迹 → Claude Code raw session log',
      '',
      '  --data-dir <path>         数据目录（默认 $ZHISHI_DATA_DIR，再回落 ~/.zhishi）——',
      '                            团队大脑跑在别的目录时用它（如 ~/.zhishi-brain）',
      '  --input <path>            源 jsonl（单线）**或目录**（批量：目录下所有 *.jsonl）',
      '                            默认 <data-dir>/loop-sessions/munmye6v-70a398b7150c.jsonl',
      '  --out <path>              单线：输出 jsonl；批量：输出目录（每线一个 <id>.raw.jsonl）',
      '                            默认 E:/trajectory.from-zhishi.jsonl',
      '  --report <path>           比对报告 md（单线用；批量模式写 manifest）',
      '  --manifest <path>         批量清单 JSON（默认 <out 目录>/manifest.json）',
      '  --limit <n>               批量上限（只导前 n 条线，按文件名字典序）——先小样本试跑用',
      '  --template <path>         比对模板（默认 E:/trajectory.raw.jsonl）',
      '  --window <n>              上下文窗口 token 数（默认 256000）',
      '  --ratio <r>               压缩触发比例（默认 0.85）',
      '  --model <id>              摘要模型（默认 deepseek-flash）',
      '  --base-url <url>          OpenAI 兼容端点根（默认 https://api.deepseek.com/v1）',
      '  --heuristic <cjk|pi>      token 估算口径（默认 cjk = 仓库 context-manager 口径；pi = chars/4）',
      '  --summary-max-tokens <n>  送进摘要模型的单次输入上限（默认 90000）',
      '  --max-output-tokens <n>   摘要模型输出上限（默认 16000）',
      '  --timeout-ms <n>          单次 LLM 调用超时（默认 600000）',
      '  --git-branch <b>          写入 gitBranch（默认不写，见 README/报告说明）',
      '  --summaries <path>        摘要缓存（JSON）：存在则复用，运行后回写（省重复 LLM 调用）',
      '  --dry-run                 不调 LLM，全部用机械兜底摘要',
      '',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// token 估算（与 packages/zhishi-loop-core/src/context-manager.ts 同口径）
// ---------------------------------------------------------------------------

const CJK_CHAR = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/gu;

/** context-manager.ts:estimateTextTokens —— CJK 1 tok/字，其余 2.5 字符/tok。 */
function estimateCjk(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK_CHAR)?.length ?? 0;
  return Math.ceil(cjk + (text.length - cjk) / 2.5);
}

/** pi 口径：chars/4。 */
function estimatePi(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0;
}

function estimateText(text: string, heuristic: 'cjk' | 'pi'): number {
  return heuristic === 'pi' ? estimatePi(text) : estimateCjk(text);
}

// ---------------------------------------------------------------------------
// 输入解析
// ---------------------------------------------------------------------------

interface ZhishiBlock {
  type?: string;
  thinking?: string;
  thinkingSignature?: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

interface ZhishiMessage {
  role: 'user' | 'assistant' | 'toolResult';
  content: string | ZhishiBlock[] | Array<{ type?: string; text?: string }>;
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  details?: Record<string, unknown>;
  model?: string;
  stopReason?: string;
  responseId?: string;
}

interface ZhishiMeta {
  kind: 'meta';
  model?: string;
  providerId?: string;
  createdAt?: string;
  updatedAt?: string;
  tokenCalibration?: number;
}

type ZhishiLine = ZhishiMeta | ({ kind?: string } & ZhishiMessage);

function readJsonl<T>(path: string): T[] {
  const raw = readFileSync(path, 'utf8');
  const out: T[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    out.push(JSON.parse(s) as T);
  }
  return out;
}

/** 消息文本（对应 context-manager.ts:messageText，toolCall 计入 name + arguments）。 */
function messageText(m: ZhishiMessage): string {
  const c = m.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c
    .map((b) => {
      if (!b || typeof b !== 'object') return '';
      const r = b as Record<string, unknown>;
      if (typeof r.text === 'string') return r.text;
      if (typeof r.thinking === 'string') return r.thinking;
      if (r.type === 'toolCall') return `${String(r.name ?? '')} ${JSON.stringify(r.arguments ?? {})}`;
      if (r.type === 'tool_result') return typeof r.content === 'string' ? r.content : '';
      return '';
    })
    .join('\n');
}

function estimateMessage(m: ZhishiMessage, heuristic: 'cjk' | 'pi'): number {
  return estimateText(messageText(m), heuristic);
}

function toolResultText(m: ZhishiMessage): string {
  const c = m.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c
    .map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
    .filter((s) => s.length > 0)
    .join('\n');
}

// ---------------------------------------------------------------------------
// 输出行模型
// ---------------------------------------------------------------------------

type LineKind = 'queue' | 'message' | 'summary' | 'boundary';

interface OutRec {
  kind: LineKind;
  uuid: string;
  /** 'prev' = 链到上一行的 uuid；'null' = 显式 null（首条消息行 / compact_boundary）。 */
  parent: 'prev' | 'null';
  /** 该记录落在哪个 turn（queue/boundary/summary 为 -1）。 */
  turn: number;
  /** token 估算（preTokens/postTokens 统计用）。 */
  tokens: number;
  line: Record<string, unknown>;
}

interface SessionMeta {
  sessionId: string;
  cwd: string;
  version: string;
  gitBranch: string;
  slug: string;
  model: string;
}

function sessionFields(meta: SessionMeta): Record<string, unknown> {
  const out: Record<string, unknown> = {
    userType: USER_TYPE,
    entrypoint: ENTRYPOINT,
    cwd: meta.cwd,
    sessionId: meta.sessionId,
    version: meta.version,
    slug: meta.slug,
  };
  if (meta.gitBranch) out.gitBranch = meta.gitBranch;
  return out;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// 转换：ZhiShi 消息 → Claude 记录
// ---------------------------------------------------------------------------

/** 切分单元（见 buildTurns 注释）。 */
interface Turn {
  index: number;
  startMsg: number;
  endMsg: number;
  tokens: number;
  toolNames: string[];
}

/**
 * 一个 turn = 「一条 user 消息（可选）+ 紧邻的一条 assistant 消息 + 该 assistant 产生的
 * 全部 toolResult」；无 user 时以 assistant 为起点。切点只落在 turn 边界上，因此
 * tool_use / tool_result 配对永不被切开（同 context-manager.ts:segmentContext 的
 * 「toolResult 永不作起点（配对不拆）」约束）。
 */
function buildTurns(messages: ZhishiMessage[], heuristic: 'cjk' | 'pi'): Turn[] {
  const turns: Turn[] = [];
  let i = 0;
  while (i < messages.length) {
    const start = i;
    if (messages[i].role === 'user') {
      i++;
      if (i < messages.length && messages[i].role === 'assistant') {
        i++;
        while (i < messages.length && messages[i].role === 'toolResult') i++;
      }
    } else if (messages[i].role === 'assistant') {
      i++;
      while (i < messages.length && messages[i].role === 'toolResult') i++;
    } else {
      // 孤儿 toolResult（异常输入）——自成一段，避免死循环。
      i++;
    }
    const turn: Turn = { index: turns.length, startMsg: start, endMsg: i - 1, tokens: 0, toolNames: [] };
    for (let k = start; k <= turn.endMsg; k++) {
      const m = messages[k];
      turn.tokens += estimateMessage(m, heuristic);
      if (m.role === 'toolResult' && m.toolName && !turn.toolNames.includes(m.toolName)) {
        turn.toolNames.push(m.toolName);
      }
    }
    turns.push(turn);
  }
  return turns;
}

/**
 * 把 ZhiShi 消息映射成 Claude 记录（不含 uuid/parentUuid——那是 emit 阶段的事）。
 * 每个 assistant 内容块独占一条 assistant 行，与模板一致。
 */
function buildMessageRecords(
  messages: ZhishiMessage[],
  turns: Turn[],
  meta: SessionMeta,
  heuristic: 'cjk' | 'pi',
): OutRec[] {
  const recs: OutRec[] = [];
  const turnOfMsg: number[] = new Array(messages.length).fill(0);
  for (const t of turns) for (let i = t.startMsg; i <= t.endMsg; i++) turnOfMsg[i] = t.index;

  const toolUseLineUuid = new Map<string, string>();

  const push = (
    kind: LineKind,
    turn: number,
    tokens: number,
    build: (uuid: string) => Record<string, unknown>,
  ): OutRec => {
    const uuid = randomUUID();
    // 首条消息行 parentUuid = null（与模板一致），其余严格链到上一行。
    const parent: 'prev' | 'null' = recs.length === 0 ? 'null' : 'prev';
    const rec: OutRec = { kind, uuid, parent, turn, tokens, line: build(uuid) };
    rec.line.uuid = uuid;
    recs.push(rec);
    return rec;
  };

  const assistantLine = (
    m: ZhishiMessage,
    meta2: SessionMeta,
    block: Record<string, unknown>,
    tsIso: string,
  ): Record<string, unknown> => ({
    parentUuid: null,
    isSidechain: false,
    message: {
      model: m.model ?? meta2.model,
      id: m.responseId ?? `msg_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      type: 'message',
      role: 'assistant',
      content: [block],
      stop_reason: mapStopReason(m.stopReason),
      stop_sequence: null,
    },
    requestId: `req_${randomUUID().replace(/-/g, '').slice(0, 22)}`,
    type: 'assistant',
    uuid: '',
    timestamp: tsIso,
    ...sessionFields(meta2),
  });

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const turn = turnOfMsg[i];
    const ts = typeof m.timestamp === 'number' ? m.timestamp : Date.now();
    const tsIso = iso(ts);

    if (m.role === 'user') {
      const text = typeof m.content === 'string' ? m.content : messageText(m);
      push('message', turn, estimateText(text, heuristic), (uuid) => {
        const line: Record<string, unknown> = {
          parentUuid: null,
          isSidechain: false,
          promptId: PROMPT_ID,
          type: 'user',
          message: { role: 'user', content: text },
          uuid,
          timestamp: tsIso,
        };
        if (recs.length === 0) line.permissionMode = PERMISSION_MODE;
        return Object.assign(line, sessionFields(meta));
      });
      continue;
    }

    if (m.role === 'assistant') {
      const blocks = Array.isArray(m.content) ? (m.content as ZhishiBlock[]) : [];
      for (const b of blocks) {
        if (b.type === 'thinking') {
          const block: Record<string, unknown> = { type: 'thinking', thinking: b.thinking ?? '' };
          if (b.thinkingSignature) block.signature = b.thinkingSignature;
          push('message', turn, estimateText(b.thinking ?? '', heuristic), () =>
            assistantLine(m, meta, block, tsIso));
        } else if (b.type === 'text') {
          const text = b.text ?? '';
          push('message', turn, estimateText(text, heuristic), () =>
            assistantLine(m, meta, { type: 'text', text }, tsIso));
        } else if (b.type === 'toolCall') {
          const id = b.id ?? `toolu_${randomUUID().replace(/-/g, '')}`;
          const input = (b.arguments ?? {}) as Record<string, unknown>;
          const rec = push('message', turn, estimateText(messageText({ role: 'assistant', content: [b] }), heuristic), () =>
            assistantLine(m, meta, { type: 'tool_use', id, name: b.name ?? '', input }, tsIso));
          toolUseLineUuid.set(id, rec.uuid);
        }
      }
      continue;
    }

    // toolResult → user 行（内容为 tool_result 块）
    const text = toolResultText(m);
    const toolUseId = m.toolCallId ?? '';
    push('message', turn, estimateText(text, heuristic), (uuid) => {
      const line: Record<string, unknown> = {
        parentUuid: null,
        isSidechain: false,
        promptId: PROMPT_ID,
        type: 'user',
        message: {
          role: 'user',
          content: [{ tool_use_id: toolUseId, type: 'tool_result', content: text, is_error: !!m.isError }],
        },
        uuid,
        timestamp: tsIso,
      };
      const src = toolUseLineUuid.get(toolUseId);
      if (src) line.sourceToolAssistantUUID = src;
      return Object.assign(line, sessionFields(meta));
    });
  }

  return recs;
}

function mapStopReason(raw: string | undefined): string | null {
  switch (raw) {
    case 'toolUse':
    case 'tool_use':
      return 'tool_use';
    case 'stop':
    case 'endTurn':
      return 'end_turn';
    case 'length':
    case 'maxTokens':
      return 'max_tokens';
    default:
      return raw ? raw : null;
  }
}

// ---------------------------------------------------------------------------
// 摘要输入构造（压缩窗口 → 送模型的压缩抄本）
// ---------------------------------------------------------------------------

function renderMessageForSummary(m: ZhishiMessage, toolTrunc: number): string {
  const ts = typeof m.timestamp === 'number' ? iso(m.timestamp) : '';
  if (m.role === 'user') {
    return `### USER [${ts}]\n${typeof m.content === 'string' ? m.content : messageText(m)}`;
  }
  if (m.role === 'assistant') {
    const blocks = Array.isArray(m.content) ? (m.content as ZhishiBlock[]) : [];
    const parts: string[] = [];
    for (const b of blocks) {
      if (b.type === 'text') parts.push(`[text] ${b.text ?? ''}`);
      else if (b.type === 'toolCall') parts.push(`[tool_use ${b.name ?? ''}] ${truncate(JSON.stringify(b.arguments ?? {}), toolTrunc)}`);
      // thinking 不进摘要输入（体积大、信息密度低）
    }
    if (parts.length === 0) return '';
    return `### ASSISTANT [${ts}]\n${parts.join('\n')}`;
  }
  const text = toolResultText(m);
  return `### TOOL_RESULT ${m.toolName ?? ''}${m.isError ? ' (ERROR)' : ''} [${ts}]\n${truncate(text, toolTrunc)}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}

/**
 * 把窗口内的消息压成抄本，并把总 token 估算压到 budget 以内。
 * 两段策略：(a) 自适应收紧 toolResult / tool_use 参数截断；(b) 仍超则头尾保留硬截。
 */
function buildSummaryInput(
  messages: ZhishiMessage[],
  budget: number,
  heuristic: 'cjk' | 'pi',
): { text: string; tokens: number; truncated: boolean; truncatedNote?: string } {
  let trunc = 1500;
  let text = '';
  for (;;) {
    text = messages
      .map((m) => renderMessageForSummary(m, trunc))
      .filter((s) => s.length > 0)
      .join('\n\n');
    if (estimateText(text, heuristic) <= budget || trunc <= 150) break;
    trunc = Math.floor(trunc / 2);
  }
  let tokens = estimateText(text, heuristic);
  let truncated = trunc < 1500;
  const ways: string[] = [];
  if (truncated) ways.push(`逐条截断到 ${trunc} 字符`);
  if (tokens > budget) {
    const head = Math.floor(text.length * 0.55);
    const tail = text.length - head;
    text = `${text.slice(0, head)}\n\n…[middle of the window omitted to fit the summarizer context]…\n\n${text.slice(text.length - tail)}`;
    tokens = estimateText(text, heuristic);
    truncated = true;
    ways.push('省略窗口中段');
  }
  return {
    text,
    tokens,
    truncated,
    // 1.9.5 文案修正：`tokens` 是**压缩后**的估算，所以不能再拿它去说「超出上限」——
    // 那是自相矛盾（常见日志形如「估算 83874 tok，超出 --summary-max-tokens=90000」）。
    // 如实说明压缩方式，并点明后果（窗口内早期内容可能未进摘要）。
    ...(truncated ? { truncatedNote: `${ways.join(' + ')}（压缩后估算 ${tokens} tok）` } : {}),
  };
}

// ---------------------------------------------------------------------------
// LLM 摘要
// ---------------------------------------------------------------------------

interface LlmConfig {
  apiKey: string;
  baseUrl: string;
}

function loadDeepseekConfig(configPath: string, providerId: string): LlmConfig {
  if (!existsSync(configPath)) throw new Error(`config 不存在: ${configPath}`);
  const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as {
    providerApiKeys?: Record<string, string>;
  };
  const apiKey = cfg.providerApiKeys?.[providerId];
  if (!apiKey) throw new Error(`config 里没有 providerApiKeys.${providerId}`);
  return { apiKey, baseUrl: '' };
}

const SUMMARY_SYSTEM = [
  'You compact an AI coding agent session log so that work can continue in a fresh context window.',
  'You will receive a (possibly truncated) transcript of the earlier portion of a session.',
  'Produce the replacement summary that will be inserted verbatim into the session log.',
  '',
  'Output ONLY the nine numbered sections below, in this exact order and with these exact headings,',
  'nothing before "1." and nothing after the last section:',
  '',
  ...SUMMARY_SECTIONS.map((s, i) => `${i + 1}. **${s}:**`),
  '',
  'Rules:',
  '- Be specific and concrete: preserve file paths, commands, identifiers, addresses, and constants verbatim.',
  '- Section 6 ("All user messages") must list every distinct user instruction, quoted or closely paraphrased.',
  '- Section 7 ("Pending Tasks") is a checklist; section 8 ("Current Work") describes what was in flight.',
  '- Section 9 ("Optional Next Step") states the single next action, tied to the most recent work.',
  '- Write in the same language the user used for their instructions.',
  '- Do not add commentary, preamble, or closing remarks.',
].join('\n');

interface SummaryResult {
  text: string;
  tokens: number;
  durationMs: number;
  source: 'llm' | 'fallback';
  note?: string;
}

/** 缓存里只存文本与元信息，tokens 一律按当前口径重算。 */
type CachedSummary = Omit<SummaryResult, 'tokens'>;

async function generateSummary(
  messages: ZhishiMessage[],
  turnRange: [number, number],
  opts: Options,
  llm: LlmConfig,
): Promise<SummaryResult> {
  const {
    text: transcript,
    truncated,
    truncatedNote,
  } = buildSummaryInput(
    messages,
    opts.summaryMaxTokens,
    opts.heuristic,
  );
  const userPrompt = [
    `Session transcript (earlier portion), turns ${turnRange[0]}..${turnRange[1]}:`,
    '',
    transcript,
    '',
    `Produce the compaction summary for turns ${turnRange[0]}..${turnRange[1]} now.`,
  ].join('\n');

  const started = Date.now();
  let body = '';
  let outputTruncated = false;
  let note: string | undefined;
  try {
    // 推理模型的 reasoning 也吃 max_tokens；一旦被截断就翻倍重试一次。
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await callChatCompletions(llm, opts, SUMMARY_SYSTEM, userPrompt, opts.maxOutputTokens * (attempt + 1));
      body = r.content;
      outputTruncated = r.truncated;
      if (!outputTruncated) break;
      process.stderr.write(`[warn] 摘要输出被 max_tokens 截断，以 ${opts.maxOutputTokens * (attempt + 2)} 重试\n`);
    }
  } catch (err) {
    note = err instanceof Error ? err.message : String(err);
  }
  const durationMs = Date.now() - started;

  if (body.trim()) {
    const text = COMPACT_PREAMBLE + normalizeSections(body) + COMPACT_TRAILER;
    const missing = missingSections(text);
    const notes: string[] = [];
    if (truncated) {
      notes.push(
        `摘要输入已压缩：${truncatedNote ?? '(方式未记录)'}，上限 --summary-max-tokens=${opts.summaryMaxTokens}`
        + '——该窗口最早/最细的部分可能未进入摘要',
      );
    }
    if (outputTruncated) notes.push('LLM 输出受 max_tokens 截断（已重试一次仍被截断）');
    if (missing.length > 0) notes.push(`摘要结构不完整，缺少 ${missing.join('、')}`);
    if (notes.length > 0) {
      note = notes.join('；');
      process.stderr.write(`[warn] 摘要质量提示：${note}\n`);
    }
    return { text, tokens: estimateText(text, opts.heuristic), durationMs, source: 'llm', note };
  }

  const text = COMPACT_PREAMBLE + mechanicalSections(turnRange) + COMPACT_TRAILER;
  return {
    text,
    tokens: estimateText(text, opts.heuristic),
    durationMs,
    source: 'fallback',
    note: note ?? 'LLM 返回空内容',
  };
}

/** 检查 9 段是否齐全（LLM 输出的结构校验）。 */
function missingSections(text: string): string[] {
  const missing: string[] = [];
  SUMMARY_SECTIONS.forEach((s, i) => {
    const re = new RegExp(`^\\s*${i + 1}[.、]\\s*\\**\\s*${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm');
    if (!re.test(text)) missing.push(`${i + 1}. ${s}`);
  });
  return missing;
}

/** LLM 有时会把 9 段包进 ``` 围栏或加前言，做最小归一化。 */
function normalizeSections(body: string): string {
  let s = body.trim();
  const fence = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/;
  const m = fence.exec(s);
  if (m) s = m[1].trim();
  // 若模型把 "Summary:" 也输出了，去掉重复。
  s = s.replace(/^Summary:\s*\n/, '');
  return s.trim();
}

function mechanicalSections(turnRange: [number, number]): string {
  const r = `${turnRange[0]}..${turnRange[1]}`;
  return [
    `${FALLBACK_MARK}`,
    '',
    ...SUMMARY_SECTIONS.map((s, i) => `${i + 1}. **${s}:** 见原轨迹 turn ${r}（机械兜底，无 LLM 生成内容）。`),
  ].join('\n');
}

async function callChatCompletions(
  llm: LlmConfig,
  opts: Options,
  system: string,
  user: string,
  maxTokens: number,
): Promise<{ content: string; truncated: boolean }> {
  const url = `${llm.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${llm.apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: maxTokens,
      temperature: 0.2,
      stream: false,
    }),
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${raw.slice(0, 400)}`);
  }
  const parsed = JSON.parse(raw) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  };
  const choice = parsed.choices?.[0];
  const content = choice?.message?.content ?? '';
  if (!content.trim()) {
    throw new Error(`LLM 返回空内容（finish_reason=${choice?.finish_reason ?? '?'}）`);
  }
  return { content, truncated: choice?.finish_reason === 'length' };
}

// ---------------------------------------------------------------------------
// cwd 解析（env-sessions.json）
// ---------------------------------------------------------------------------

function resolveWorkspace(envSessionsPath: string, sessionId: string): string | null {
  if (!existsSync(envSessionsPath)) return null;
  let parsed: { lines?: Record<string, { loopSessionId?: string; updatedAt?: string }> };
  try {
    parsed = JSON.parse(readFileSync(envSessionsPath, 'utf8'));
  } catch {
    return null;
  }
  const lines = parsed.lines ?? {};
  let best: { ws: string; updatedAt: string } | null = null;
  for (const [key, val] of Object.entries(lines)) {
    if (val?.loopSessionId !== sessionId) continue;
    const sep = key.indexOf('::');
    const ws = sep >= 0 ? key.slice(0, sep) : key;
    const updatedAt = val.updatedAt ?? '';
    if (!best || updatedAt > best.updatedAt) best = { ws, updatedAt };
  }
  return best ? best.ws : null;
}

function readRepoVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { version?: string };
    return `zhishi-${pkg.version ?? '0.0.0'}`;
  } catch {
    return 'zhishi-0.0.0';
  }
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

interface WindowReport {
  window: number;
  turnStart: number;
  turnEnd: number;
  turns: number;
  preTokens: number | null;
  postTokens: number | null;
  durationMs: number | null;
  summarySource: 'llm' | 'fallback' | null;
  summaryNote?: string;
  toolNames: string[];
}

interface BuildResult {
  lines: string[];
  typeCounts: Record<string, number>;
  windows: WindowReport[];
  boundaries: Array<{ uuid: string; preTokens: number; postTokens: number; durationMs: number; source: string }>;
  chainErrors: string[];
  turns: Turn[];
  fallbackCount: number;
  llmCount: number;
}

async function build(
  messages: ZhishiMessage[],
  meta: SessionMeta,
  opts: Options,
  llm: LlmConfig | null,
  summaryCache: Map<string, SummaryResult>,
  reuseSummaries: boolean,
): Promise<BuildResult> {
  const turns = buildTurns(messages, opts.heuristic);
  const threshold = opts.window * opts.ratio;

  // ---- 切分（顺序推进：每切一刀先出摘要，摘要 token 计入下一窗口） ----
  interface Cut {
    cutBeforeTurn: number;
    windowStartTurn: number;
    windowEndTurn: number;
    preTokens: number;
    summary: SummaryResult;
    toolNames: string[];
  }
  const cuts: Cut[] = [];
  let windowStartTurn = 0;
  let running = 0;
  let i = 0;

  while (i < turns.length) {
    running += turns[i].tokens;
    i++;
    if (running > threshold && i - 1 > windowStartTurn) {
      const windowEndTurn = i - 1;
      const msgs = messages.slice(turns[windowStartTurn].startMsg, turns[windowEndTurn].endMsg + 1);
      const toolNames: string[] = [];
      for (const t of turns.slice(windowStartTurn, windowEndTurn + 1)) {
        for (const n of t.toolNames) if (!toolNames.includes(n)) toolNames.push(n);
      }
      let summary: SummaryResult;
      const cacheKey = `${windowStartTurn}-${windowEndTurn}`;
      const cached = summaryCache.get(cacheKey);
      if (cached && reuseSummaries) {
        summary = cached;
        process.stderr.write(`[info] 复用摘要缓存 ${cacheKey}\n`);
      } else if (opts.dryRun || !llm) {
        const text = COMPACT_PREAMBLE + mechanicalSections([windowStartTurn, windowEndTurn]) + COMPACT_TRAILER;
        summary = {
          text,
          tokens: estimateText(text, opts.heuristic),
          durationMs: 0,
          source: 'fallback',
          note: opts.dryRun ? '--dry-run' : '未配置 LLM',
        };
      } else {
        summary = await generateSummary(msgs, [windowStartTurn, windowEndTurn], opts, llm);
        summaryCache.set(cacheKey, summary);
      }
      cuts.push({
        cutBeforeTurn: i,
        windowStartTurn,
        windowEndTurn,
        preTokens: running,
        summary,
        toolNames,
      });
      running = summary.tokens;
      windowStartTurn = i;
    }
  }

  // ---- 记录序列 ----
  const metaRecs = buildMessageRecords(messages, turns, meta, opts.heuristic);

  const ordered: OutRec[] = [];
  const queueTimestamp = typeof messages[0]?.timestamp === 'number' ? messages[0].timestamp : Date.now();
  ordered.push({
    kind: 'queue',
    uuid: '',
    parent: 'prev',
    turn: -1,
    tokens: 0,
    line: {
      type: 'queue-operation',
      operation: 'enqueue',
      timestamp: iso(queueTimestamp),
      sessionId: meta.sessionId,
      content: typeof messages[0]?.content === 'string' ? messages[0].content : messageText(messages[0]),
    },
  });
  ordered.push({
    kind: 'queue',
    uuid: '',
    parent: 'prev',
    turn: -1,
    tokens: 0,
    line: {
      type: 'queue-operation',
      operation: 'dequeue',
      timestamp: iso(queueTimestamp),
      sessionId: meta.sessionId,
    },
  });

  const windows: WindowReport[] = [];
  const boundaries: BuildResult['boundaries'] = [];
  const byTurn = new Map<number, OutRec[]>();
  for (const r of metaRecs) {
    if (r.turn < 0) continue;
    const arr = byTurn.get(r.turn);
    if (arr) arr.push(r);
    else byTurn.set(r.turn, [r]);
  }

  let windowNo = 0;
  let cursorTurn = 0;
  for (let c = 0; c <= cuts.length; c++) {
    const cut = cuts[c];
    const endTurn = cut ? cut.windowEndTurn : turns.length - 1;
    // 先铺本窗口的记录，再把紧接其后的压缩事件（boundary + summary）插进去。
    for (let t = cursorTurn; t <= endTurn; t++) {
      for (const r of byTurn.get(t) ?? []) ordered.push(r);
    }
    if (cut) {
      const lastMsgTs = typeof messages[turns[endTurn].endMsg]?.timestamp === 'number'
        ? (messages[turns[endTurn].endMsg].timestamp as number)
        : Date.now();
      const nextMsgTs = typeof messages[turns[cut.cutBeforeTurn].startMsg]?.timestamp === 'number'
        ? (messages[turns[cut.cutBeforeTurn].startMsg].timestamp as number)
        : lastMsgTs;
      const at = Math.max(lastMsgTs, nextMsgTs);
      const boundaryUuid = randomUUID();
      ordered.push({
        kind: 'boundary',
        uuid: boundaryUuid,
        parent: 'null',
        turn: -1,
        tokens: 0,
        line: {
          parentUuid: null,
          logicalParentUuid: '',
          isSidechain: false,
          type: 'system',
          subtype: 'compact_boundary',
          content: 'Conversation compacted',
          isMeta: false,
          timestamp: iso(at),
          uuid: boundaryUuid,
          level: 'info',
          compactMetadata: {
            trigger: 'auto',
            preTokens: cut.preTokens,
            preCompactDiscoveredTools: cut.toolNames.slice(0, 3),
            postTokens: cut.summary.tokens,
            durationMs: cut.summary.durationMs,
          },
          ...sessionFields(meta),
        },
      });
      const summaryRec: OutRec = {
        kind: 'summary',
        uuid: randomUUID(),
        parent: 'prev',
        turn: -1,
        tokens: cut.summary.tokens,
        line: {
          parentUuid: null,
          isSidechain: false,
          promptId: PROMPT_ID,
          type: 'user',
          message: { role: 'user', content: cut.summary.text },
          uuid: '',
          timestamp: iso(at),
          isVisibleInTranscriptOnly: true,
          isCompactSummary: true,
          ...sessionFields(meta),
        },
      };
      summaryRec.line.uuid = summaryRec.uuid;
      ordered.push(summaryRec);
      boundaries.push({
        uuid: boundaryUuid,
        preTokens: cut.preTokens,
        postTokens: cut.summary.tokens,
        durationMs: cut.summary.durationMs,
        source: cut.summary.source,
      });
      if (cut.summary.source === 'fallback') {
        process.stderr.write(
          `[warn] 窗口 ${windowNo}（turn ${cut.windowStartTurn}..${cut.windowEndTurn}）摘要为机械兜底：${cut.summary.note ?? 'unknown'}\n`,
        );
      }
    }
    windows.push({
      window: windowNo,
      turnStart: cursorTurn,
      turnEnd: endTurn,
      turns: endTurn - cursorTurn + 1,
      preTokens: cut ? cut.preTokens : null,
      postTokens: cut ? cut.summary.tokens : null,
      durationMs: cut ? cut.summary.durationMs : null,
      summarySource: cut ? cut.summary.source : null,
      summaryNote: cut?.summary.note,
      toolNames: cut
        ? cut.toolNames
        : [...new Set(turns.slice(cursorTurn, endTurn + 1).flatMap((t) => t.toolNames))],
    });
    cursorTurn = endTurn + 1;
    windowNo++;
  }

  // ---- parentUuid 链（严格线性；boundary 的 logicalParentUuid = 切点前的最后一行） ----
  const chainErrors: string[] = [];
  let prev: string | null = null;
  for (const r of ordered) {
    if (r.kind === 'queue') {
      prev = null;
      continue;
    }
    r.line.uuid = r.uuid;
    if (r.kind === 'boundary') {
      (r.line as { logicalParentUuid: unknown }).logicalParentUuid = prev;
      r.line.parentUuid = null;
    } else {
      r.line.parentUuid = r.parent === 'null' ? null : prev;
    }
    prev = r.uuid;
  }

  // ---- 校验链 ----
  const known = new Set(ordered.filter((r) => r.kind !== 'queue').map((r) => r.uuid));
  let chainPrev: string | null = null;
  for (const r of ordered) {
    if (r.kind === 'queue') {
      chainPrev = null;
      continue;
    }
    const p = (r.line as { parentUuid?: unknown }).parentUuid as string | null;
    if (r.kind === 'boundary') {
      const lp = (r.line as { logicalParentUuid?: unknown }).logicalParentUuid as string | null;
      if (lp === null) chainErrors.push('boundary.logicalParentUuid 为 null（切点前必有消息）');
      else if (lp !== chainPrev) chainErrors.push(`boundary.logicalParentUuid != 上一行 uuid (${lp} vs ${chainPrev})`);
      if (p !== null) chainErrors.push('boundary.parentUuid 应为 null');
    } else if (p !== null && !known.has(p)) {
      chainErrors.push(`parentUuid 未解析: ${p} (${r.kind})`);
    }
    const s = (r.line as { sourceToolAssistantUUID?: string }).sourceToolAssistantUUID ?? null;
    if (s && !known.has(s)) chainErrors.push(`sourceToolAssistantUUID 未解析: ${s}`);
    chainPrev = r.uuid;
  }

  const lines = ordered.map((r) => JSON.stringify(r.line));
  const typeCounts: Record<string, number> = {};
  for (const r of ordered) {
    const key = r.kind === 'boundary' ? 'system/compact_boundary' : (r.line.type as string);
    typeCounts[key] = (typeCounts[key] ?? 0) + 1;
  }

  const llmCount = cuts.filter((c) => c.summary.source === 'llm').length;
  return {
    lines,
    typeCounts,
    windows,
    boundaries,
    chainErrors,
    turns,
    fallbackCount: cuts.length - llmCount,
    llmCount,
  };
}

// ---------------------------------------------------------------------------
// 比对报告
// ---------------------------------------------------------------------------

interface TemplateStats {
  present: boolean;
  path: string;
  total: number;
  typeCounts: Record<string, number>;
  boundaries: Array<{ preTokens: number; postTokens: number; durationMs: number }>;
}

function templateStats(path: string): TemplateStats {
  if (!existsSync(path)) {
    return { present: false, path, total: 0, typeCounts: {}, boundaries: [] };
  }
  const rows = readJsonl<Record<string, unknown>>(path);
  const typeCounts: Record<string, number> = {};
  const boundaries: TemplateStats['boundaries'] = [];
  for (const d of rows) {
    const t = String(d.type ?? '?');
    const key = t === 'system' ? `system/${String(d.subtype ?? '?')}` : t;
    typeCounts[key] = (typeCounts[key] ?? 0) + 1;
    if (t === 'system' && d.subtype === 'compact_boundary') {
      const cm = (d.compactMetadata ?? {}) as { preTokens?: number; postTokens?: number; durationMs?: number };
      boundaries.push({
        preTokens: cm.preTokens ?? 0,
        postTokens: cm.postTokens ?? 0,
        durationMs: cm.durationMs ?? 0,
      });
    }
  }
  return { present: true, path, total: rows.length, typeCounts, boundaries };
}

function buildReport(
  opts: Options,
  meta: SessionMeta,
  result: BuildResult,
  tpl: TemplateStats,
  srcStats: { totalLines: number; metaLines: number; totalMessages: number; roles: Record<string, number>; meta: ZhishiMeta },
): string {
  const out: string[] = [];
  out.push('# trajectory.from-zhishi 比对报告');
  out.push('');
  out.push(`- 源：\`${opts.input}\`（只读）`);
  out.push(`- 产物：\`${opts.out}\`（${result.lines.length} 行）`);
  out.push(`- 模板：\`${tpl.path}\`（${tpl.present ? `${tpl.total} 行` : '缺失，已跳过比对'}）`);
  out.push(`- sessionId：\`${meta.sessionId}\` cwd：\`${meta.cwd}\` version：\`${meta.version}\` slug：\`${meta.slug}\``);
  out.push(`- 估算口径：\`${opts.heuristic}\`（cjk = 仓库 context-manager 口径；pi = chars/4）`);
  out.push(`- 压缩阈值：${opts.window} × ${opts.ratio} = ${Math.round(opts.window * opts.ratio)} tok`);
  out.push(`- tokenCalibration：${srcStats.meta.tokenCalibration ?? '（源 meta 未提供 → 系数 1.0）'}`);
  out.push(`- 摘要来源：LLM ${result.llmCount} 次，机械兜底 ${result.fallbackCount} 次`);
  out.push('');

  out.push(`## 1. 源轨迹统计`);
  out.push('');
  out.push(`文件总行数 ${srcStats.totalLines}（meta ${srcStats.metaLines} 行 + 消息 ${srcStats.totalMessages} 条）；角色分布：${Object.entries(srcStats.roles).map(([k, v]) => `\`${k}\`×${v}`).join('、')}`);
  out.push('');
  out.push(`turn 数（切分单元：user+assistant+其 toolResult，或 assistant+其 toolResult）：${result.turns.length}`);
  out.push('');

  out.push('## 2. 行类型分布（产物 vs 模板）');
  out.push('');
  const keys = [...new Set([...Object.keys(result.typeCounts), ...Object.keys(tpl.typeCounts)])].sort();
  out.push('| 行类型 | 产物 | 模板 |');
  out.push('| --- | --- | --- |');
  for (const k of keys) out.push(`| \`${k}\` | ${result.typeCounts[k] ?? 0} | ${tpl.typeCounts[k] ?? 0} |`);
  out.push(`| **合计** | **${result.lines.length}** | **${tpl.present ? tpl.total : '—'}** |`);
  out.push('');

  out.push('## 3. 压缩边界');
  out.push('');
  out.push('| # | 产物 preTokens | 产物 postTokens | durationMs | 摘要来源 | 模板 preTokens | 模板 postTokens | 模板 durationMs |');
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  const n = Math.max(result.boundaries.length, tpl.boundaries.length);
  for (let i = 0; i < n; i++) {
    const b = result.boundaries[i];
    const t = tpl.boundaries[i];
    out.push(
      `| ${i + 1} | ${b ? b.preTokens : '—'} | ${b ? b.postTokens : '—'} | ${b ? b.durationMs : '—'} | ${b ? b.source : '—'} | ${t ? t.preTokens : '—'} | ${t ? t.postTokens : '—'} | ${t ? t.durationMs : '—'} |`,
    );
  }
  out.push('');

  out.push('## 4. 每窗口 turn 区间');
  out.push('');
  out.push('| 窗口 | turn 区间 | turn 数 | preTokens（切点） | postTokens | durationMs | 摘要来源 | 窗口内工具 |');
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const w of result.windows) {
    out.push(
      `| ${w.window} | ${w.turnStart}..${w.turnEnd} | ${w.turns} | ${w.preTokens ?? '—'} | ${w.postTokens ?? '—'} | ${w.durationMs ?? '—'} | ${w.summarySource ?? '（末窗口，无切）'} | ${w.toolNames.join(', ') || '—'} |`,
    );
  }
  out.push('');
  if (result.windows.some((w) => w.summaryNote)) {
    out.push('摘要备注：');
    for (const w of result.windows) if (w.summaryNote) out.push(`- 窗口 ${w.window}：${w.summaryNote}`);
    out.push('');
  }

  out.push('## 5. 链完整性');
  out.push('');
  out.push(result.chainErrors.length === 0
    ? '- ✅ 所有 `parentUuid` / `logicalParentUuid` / `sourceToolAssistantUUID` 均可解析，边界链正确（boundary.parentUuid = null，summary.parentUuid = boundary.uuid）。'
    : `- ❌ ${result.chainErrors.length} 处异常：\n${result.chainErrors.map((e) => `  - ${e}`).join('\n')}`);
  out.push('');

  out.push('## 6. 与模板的差异（有意为之）');
  out.push('');
  out.push('- **attachment 行（模板 46 条）**：模板里是 Claude Code 的 `deferred_tools_delta` / 文件读取附件，ZhiShi 轨迹没有对应物，不伪造。');
  out.push('- **last-prompt 行（模板 63 条）**：Claude Code 每次入队提示时写的旁路记录，ZhiShi 无对应概念，不生成。');
  out.push('- **toolUseResult 字段**：模板的 tool_result 行另带 Claude 工具专属的原始结果对象；ZhiShi 的 `details` 形状不同（如 `{exitCode,truncated}`），不做有损映射，仅在 tool_result 行保留 `sourceToolAssistantUUID` 作为配对线索。');
  out.push('- **gitBranch**：按任务要求跳过（可用 `--git-branch` 补）。');
  out.push('- **entrypoint / version / sessionId / slug**：按任务要求映射为 `zhishi` / `zhishi-<pkg.version>` / ZhiShi 行 id / 行 id 前 8 字符；模板分别是 `sdk-cli` / `2.1.119` / UUID / 英文 slug。');
  out.push('- **tool_use id**：保留 ZhiShi 原始的 `call_*`，未改写成模板的 `toolu_*`（改写会与 `tool_use_id` 配对一起改，本轮按任务字面要求保留原 id）。');
  out.push('- **摘要尾部**：模板的压缩摘要在段落 9 后带一句 `If you need specific details ... read the full transcript at: <path>.jsonl`；该路径在 ZhiShi 侧不存在，为避免伪造不存在的文件路径，产物省略该句，保留其后的 `Continue the conversation from where it left off ...` 收尾。');
  out.push('- **每行一个内容块**：与模板一致（模板 462 assistant 行 = 462 个块；本产物同样一块一行），`parentUuid` 为严格线性链（模板存在少量同层分支：同一 assistant 的多个 tool_result 挂同一父，本产物简化为线性序）。');
  out.push('');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

interface BatchRow {
  sessionId: string;
  input: string;
  out: string;
  cwd: string;
  sourceLines: number;
  messages: number;
  roles: Record<string, number>;
  systemPromptRecords: number;
  tokenCalibration: number | null;
  outLines: number;
  typeCounts: Record<string, number>;
  boundaries: Array<{ preTokens: number; postTokens: number; source: string }>;
  chainErrors: number;
  /** 单线模式才有：模板对账摘要行（批量模式不打印模板行，避免 N 次读大文件）。 */
  templateLine?: string;
  /** 非空 = 这条线跳过（不是线 / 缺 meta / 读坏），原因留痕。 */
  error?: string;
}

/**
 * 单线导出：读一条线 → 写 out（+ 可选 report）→ 回一行 manifest 数据。
 * 批量模式对目录里每条线调用它；单线模式调一次（那时 report 非 null）。
 */
async function runOne(
  opts: Options,
  input: string,
  out: string,
  report: string | null,
  llm: LlmConfig | null,
  summaryCache: Map<string, SummaryResult>,
  reuseSummaries: boolean,
): Promise<BatchRow> {
  const raw = readJsonl<ZhishiLine>(input);
  let metaLine: ZhishiMeta | null = null;
  const messages: ZhishiMessage[] = [];
  const roles: Record<string, number> = {};
  let systemPromptRecords = 0;
  for (const l of raw) {
    const kind = (l as { kind?: string }).kind;
    if (kind === 'meta') metaLine = l as ZhishiMeta;
    else if (kind === 'system-prompt') systemPromptRecords++;
    else if (kind) continue;
    else {
      const m = l as ZhishiMessage;
      messages.push(m);
      roles[m.role] = (roles[m.role] ?? 0) + 1;
    }
  }
  if (!metaLine) throw new Error('源文件缺少 meta 行');

  const sessionId = fileBaseName(input);
  const workspace = resolveWorkspace(opts.envSessions, sessionId);
  const cwd = workspace ?? dirname(resolve(input));
  const meta: SessionMeta = {
    sessionId,
    cwd,
    version: readRepoVersion(),
    gitBranch: opts.gitBranch,
    slug: sessionId.slice(0, 8),
    model: metaLine.model ?? opts.model,
  };

  const result = await build(messages, meta, opts, llm, summaryCache, reuseSummaries);
  // 输出目录不存在就建（批量模式同纪律）——否则用户给一个还不存在的 --out 目录会直接报错。
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, `${result.lines.join('\n')}\n`, 'utf8');

  let templateLine: string | undefined;
  if (report !== null) {
    const tpl = templateStats(opts.template);
    const md = buildReport(opts, meta, result, tpl, {
      totalLines: raw.length,
      metaLines: raw.length - messages.length,
      totalMessages: messages.length,
      roles,
      meta: metaLine,
    });
    mkdirSync(dirname(resolve(report)), { recursive: true });
    writeFileSync(report, md, 'utf8');
    templateLine = tpl.present ? `模板 ${tpl.path}：${tpl.total} 行 ${JSON.stringify(tpl.typeCounts)}` : undefined;
  }

  return {
    sessionId,
    input,
    out,
    cwd,
    sourceLines: raw.length,
    messages: messages.length,
    roles,
    systemPromptRecords,
    tokenCalibration: metaLine.tokenCalibration ?? null,
    outLines: result.lines.length,
    typeCounts: result.typeCounts,
    boundaries: result.boundaries.map((b) => ({ preTokens: b.preTokens, postTokens: b.postTokens, source: b.source })),
    chainErrors: result.chainErrors.length,
    ...(templateLine ? { templateLine } : {}),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dataDir = resolveDataDir(argv);
  const opts = parseArgs(argv, dataDir);
  process.stdout.write(`数据目录：${opts.dataDir}\n`);

  // LLM 与摘要缓存：一次加载、全批共用（config 只读一次；缓存按摘要输入哈希索引，
  // 批量 + 非 dry-run 时能显著省调用——也可先 --dry-run 出机械摘要）。
  let llm: LlmConfig | null = null;
  if (!opts.dryRun) {
    llm = loadDeepseekConfig(opts.config, 'deepseek');
    llm.baseUrl = opts.baseUrl;
    process.stdout.write(`LLM：${opts.model} @ ${opts.baseUrl}（key 已加载，不打印）\n`);
  } else {
    process.stdout.write('LLM：--dry-run，全部使用机械兜底摘要\n');
  }

  const summaryCache = new Map<string, SummaryResult>();
  let reuseSummaries = false;
  if (opts.summaries && existsSync(opts.summaries)) {
    try {
      const cached = JSON.parse(readFileSync(opts.summaries, 'utf8')) as Record<string, CachedSummary>;
      for (const [k, v] of Object.entries(cached)) {
        summaryCache.set(k, { ...v, tokens: estimateText(v.text, opts.heuristic) });
      }
      reuseSummaries = true;
      process.stdout.write(`摘要缓存：命中 ${summaryCache.size} 条（${opts.summaries}）\n`);
    } catch (err) {
      process.stderr.write(`[warn] 摘要缓存读取失败，忽略：${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  const persistSummaries = (): void => {
    if (!opts.summaries || summaryCache.size === 0) return;
    const plain: Record<string, CachedSummary> = {};
    for (const [k, v] of summaryCache) plain[k] = { text: v.text, durationMs: v.durationMs, source: v.source, note: v.note };
    mkdirSync(dirname(resolve(opts.summaries)), { recursive: true });
    writeFileSync(opts.summaries, `${JSON.stringify(plain, null, 2)}\n`, 'utf8');
  };

  if (!existsSync(opts.input)) throw new Error(`源不存在: ${opts.input}`);

  // ── 单线模式（--input <file>）──────────────────────────────────────
  if (!statSync(opts.input).isDirectory()) {
    const row = await runOne(opts, opts.input, opts.out, opts.report, llm, summaryCache, reuseSummaries);
    persistSummaries();
    process.stdout.write(`源：${row.input}\n`);
    process.stdout.write(`  messages=${row.messages} ${JSON.stringify(row.roles)} system-prompt records=${row.systemPromptRecords}\n`);
    process.stdout.write(`  sessionId=${row.sessionId} cwd=${row.cwd} heuristic=${opts.heuristic}\n`);
    process.stdout.write(`  tokenCalibration=${row.tokenCalibration ?? '(none → 1.0)'}\n`);
    process.stdout.write(`\n写出 ${row.out}（${row.outLines} 行）\n`);
    process.stdout.write(`行类型分布：${JSON.stringify(row.typeCounts)}\n`);
    process.stdout.write(
      `压缩边界：${row.boundaries.map((b) => `pre=${b.preTokens} post=${b.postTokens} ${b.source}`).join(' | ') || '（无）'}\n`,
    );
    process.stdout.write(`链完整性：${row.chainErrors === 0 ? 'OK（0 异常）' : `${row.chainErrors} 处异常`}\n`);
    if (row.templateLine) process.stdout.write(`${row.templateLine}\n`);
    process.stdout.write(`报告：${opts.report}\n`);
    if (row.chainErrors > 0) process.exitCode = 2;
    return;
  }

  // ── 批量模式（--input <目录>）──────────────────────────────────────
  const names = readdirSync(opts.input).filter(isLineFile).sort();
  const picked = opts.limit && opts.limit > 0 ? names.slice(0, opts.limit) : names;
  const outDir = resolve(opts.out);
  mkdirSync(outDir, { recursive: true });
  process.stdout.write(
    `批量：${opts.input} → ${outDir}`
    + `（候选 ${names.length} 条线${opts.limit ? `，--limit 取前 ${picked.length}` : ''}）\n`,
  );

  const rows: BatchRow[] = [];
  let i = 0;
  for (const name of picked) {
    i++;
    const input = join(opts.input, name);
    const id = fileBaseName(input);
    const out = join(outDir, `${id}.raw.jsonl`);
    try {
      const row = await runOne(opts, input, out, null, llm, summaryCache, reuseSummaries);
      rows.push(row);
      process.stdout.write(
        `[${i}/${picked.length}] ${id} → ${row.outLines} 行`
        + `（messages=${row.messages}，边界=${row.boundaries.length}，链错=${row.chainErrors}）\n`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      rows.push({
        sessionId: id, input, out, cwd: '', sourceLines: 0, messages: 0, roles: {}, systemPromptRecords: 0,
        tokenCalibration: null, outLines: 0, typeCounts: {}, boundaries: [], chainErrors: 0, error: message,
      });
      process.stdout.write(`[${i}/${picked.length}] ${id} → 跳过：${message}\n`);
    }
  }
  persistSummaries();

  const ok = rows.filter((r) => !r.error);
  const sum = (f: (r: BatchRow) => number): number => ok.reduce((s, r) => s + f(r), 0);
  const manifest = {
    tool: 'zhishi-trajectory-export',
    generatedAt: new Date().toISOString(),
    dataDir: opts.dataDir,
    inputDir: resolve(opts.input),
    outDir,
    dryRun: opts.dryRun,
    model: opts.model,
    window: opts.window,
    ratio: opts.ratio,
    heuristic: opts.heuristic,
    totals: {
      lines: rows.length,
      ok: ok.length,
      failed: rows.length - ok.length,
      outLines: sum((r) => r.outLines),
      chainErrors: sum((r) => r.chainErrors),
      compactBoundaries: sum((r) => r.boundaries.length),
      boundaryPreTokens: sum((r) => r.boundaries.reduce((t, b) => t + b.preTokens, 0)),
      boundaryPostTokens: sum((r) => r.boundaries.reduce((t, b) => t + b.postTokens, 0)),
    },
    rows,
  };
  const manifestPath = opts.manifest ? resolve(opts.manifest) : join(outDir, 'manifest.json');
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  process.stdout.write(
    `\n批量完成：成功 ${manifest.totals.ok} / 共 ${manifest.totals.lines}；`
    + `产物 ${manifest.totals.outLines} 行；压缩边界 ${manifest.totals.compactBoundaries} 处；链错 ${manifest.totals.chainErrors} 处\n`,
  );
  process.stdout.write(`清单：${manifestPath}\n`);
  if (manifest.totals.failed > 0 || manifest.totals.chainErrors > 0) process.exitCode = 2;
}

function fileBaseName(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  return base.replace(/\.jsonl$/i, '');
}

main().catch((err) => {
  process.stderr.write(`[error] ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
