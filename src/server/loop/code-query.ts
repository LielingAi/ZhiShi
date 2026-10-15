/**
 * 1.9.10 —— code_query：环境内 CPG 语义查询原生工具（设计稿
 * docs/design/code-search-design.md v2）。
 *
 * 形态与 env_exec 同层：execute 体经 env-exec 通道在**研究环境内**跑
 * joern（code-audit/pentest 配方自带）——无 daemon、无 HTTP，CPG 建在
 * `<目标根>/.zhishi-cpg/` 随环境生灭（D10/D14）。模型写 CPGQL，
 * 拿回 file:line + sed 现取的截断段落（Q3 教训内建截断纪律）。
 *
 * joern CLI 各版本 flag 有差异（joern-parse --output / joern --import），
 * 命令集中在 COMMANDS 常量区，真链路验收时按配方实钉版本校准。
 */

import { Type } from '@earendil-works/pi-ai';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';

import type { EnvironmentEntry } from '../../shared/config-types';
import { execInEnvironment } from './env-exec';

export const CODE_QUERY_TOOL_NAME = 'code_query';

/** CPG 工作目录（目标根内，随环境生灭）。 */
export const CPG_DIR = '.zhishi-cpg';
/** CPGQL 输入长度闸（清洗）。 */
const CPGL_MAX_CHARS = 4_000;
/** 结果截断纪律（设计稿 §2.3）。 */
const RESULT_MAX_ITEMS = 8;
const RESULT_MAX_CHARS_PER_ITEM = 1_200;
const RESULT_TOTAL_BUDGET = 10_240;
/** sed 现取窗口：命中行起向后取行的上下文段落。 */
const CONTEXT_LINES = 60;
/** 查询默认/硬顶超时（joern 端 + 工具端双闸的设计落点）。 */
const QUERY_TIMEOUT_DEFAULT_MS = 60_000;
const QUERY_TIMEOUT_MAX_MS = 180_000;

// ---------------------------------------------------------------------------
// 纯函数（单测面）
// ---------------------------------------------------------------------------

export interface CqResult {
  path: string;
  line_start: number;
  line_end: number;
  text: string;
  symbol?: string;
}

const TRUNC_MARK = '…[truncated]';

/** 结果截断：条数 ≤8 · 单条 ≤1200 字符 · 总量 ≤10KB——超顶丢尾部并标注。 */
export function truncateResults(
  results: CqResult[],
  maxItems = RESULT_MAX_ITEMS,
  maxCharsPerItem = RESULT_MAX_CHARS_PER_ITEM,
  totalBudget = RESULT_TOTAL_BUDGET,
): CqResult[] {
  const cut = (text: string, budget: number): string => {
    const room = Math.max(0, budget);
    return text.length > room ? text.slice(0, room) + TRUNC_MARK : text;
  };
  const out: CqResult[] = [];
  let spent = 0;
  for (const r of results.slice(0, maxItems)) {
    const remaining = totalBudget - spent;
    if (remaining <= 32) { // 预算见底：塞一条标注收尾
      out.push({ ...r, text: TRUNC_MARK });
      break;
    }
    const text = cut(r.text, Math.min(maxCharsPerItem, remaining));
    spent += text.length;
    out.push({ ...r, text });
    if (out.length === maxItems && results.length > maxItems) {
      out[out.length - 1] = { ...out[out.length - 1], text: cut(out[out.length - 1].text, maxCharsPerItem - TRUNC_MARK.length) + TRUNC_MARK };
    }
  }
  return out;
}

/** joern 脚本写出的 JSONL（{"path","line","name"?} 每行）→ 结果数组；坏行跳过。 */
export function parseJoernJson(raw: string): Array<{ path: string; line_start: number; symbol?: string }> {
  const out: Array<{ path: string; line_start: number; symbol?: string }> = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const m = JSON.parse(t) as { path?: unknown; line?: unknown; name?: unknown };
      if (typeof m.path !== 'string' || typeof m.line !== 'number') continue;
      out.push({
        path: m.path,
        line_start: m.line,
        ...(typeof m.name === 'string' ? { symbol: m.name } : {}),
      });
    } catch { /* 坏行跳过 */ }
  }
  return out;
}

/** CPGQL 清洗：剥控制字符（\n 保留）、\r 直接删（裸 \r 变 \n 会把单行查询折断），4K 长度闸。
 *  模型在环境内本就可 env_exec，此处防的是意外粘贴物撑爆/折断脚本，不是安全边界。 */
export function cleanCpgl(q: string): string {
  const cleaned = q
    .replace(/\r\n?/g, '')
    // eslint-disable-next-line no-control-regex -- 本意即清洗 C0 控制字符（\n 已豁免在上一步外的字符集外）
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  return cleaned.length > CPGL_MAX_CHARS ? cleaned.slice(0, CPGL_MAX_CHARS) : cleaned;
}

export type CpgState = 'missing' | 'building' | 'ready' | 'stale' | 'failed';

interface CpgMeta { state?: string; fingerprint?: string; error?: string }

/** CPG 状态机：元数据 × 当前树指纹 → 服务状态（stale = 旧图仍服务但标注）。 */
export function cpgStateFromMeta(meta: CpgMeta | null, currentFingerprint: string): CpgState {
  if (!meta || !meta.state) return 'missing';
  if (meta.state === 'failed') return 'failed';
  if (meta.state === 'building') return 'building';
  if (meta.state === 'ready') {
    return meta.fingerprint === currentFingerprint ? 'ready' : 'stale';
  }
  return 'missing';
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const codeQueryParameters = Type.Object({
  query: Type.String({ description: 'CPGQL 查询表达式（例：cpg.call("memcpy").argument(2).reachableBy(cpg.call("recv")).l）' }),
  target: Type.Optional(Type.String({ description: '目标树根路径（缺省 = 环境工作目录）' })),
  action: Type.Optional(Type.String({ description: "query（缺省）| ensure_index | status" })),
  timeout_sec: Type.Optional(Type.Number({ description: `查询超时秒数（默认 ${QUERY_TIMEOUT_DEFAULT_MS / 1000}，硬顶 ${QUERY_TIMEOUT_MAX_MS / 1000}）` })),
});

/** 依赖注入面：execute 内的环境命令执行（单测以假实现注入）。 */
export interface CodeQueryExec {
  (cmd: string, timeoutMs: number): Promise<{ ok: boolean; stdout: string; stderr: string }>;
}

function defaultExec(env: EnvironmentEntry): CodeQueryExec {
  return async (cmd, timeoutMs) => {
    const r = await execInEnvironment(env, cmd, { timeoutMs });
    // EnvResult 判别联合：失败分支无 stdout/stderr——收窄后取，错误进 stderr 通道。
    // 注意 ok 语义：execInEnvironment 的 ok 只代表「通道执行成功」，非零 exitCode
    // 仍算 ok——code_query 要靠 joern 退出码区分编译错 vs 0 命中，必须把 exitCode
    // 折进 ok（E2E 实校：语法错被误报成「0 命中」的根因）。
    return {
      ok: r.ok && (r.exitCode ?? 0) === 0,
      stdout: r.ok ? (r.stdout ?? '') : '',
      stderr: r.ok ? (r.stderr ?? '') : (r as { error?: string }).error ?? '',
    };
  };
}

/** joern 命令模板（版本差异集中在此，真链路验收时按配方实钉校准）。 */
const CMD = {
  hasJoern: 'command -v joern-parse >/dev/null 2>&1 && echo yes || echo no',
  /** 指纹：目标根文件集 count+size+最新 mtime 的轻量摘要（增量的快筛键）。
   *  注意：awk 程序在单引号内，base64 包装只经一次 bash 解析，$ 不需要反斜杠
   *  转义——mawk 对 \$ 直接语法错（E2E 实校：指纹恒空串引发的 stale 重建风暴）。 */
  fingerprint: (root: string) =>
    `cd ${root} && find . -type f -not -path './${CPG_DIR}/*' -printf '%s %T@\\n' 2>/dev/null | awk '{s+=$1; if($2>m)m=$2; n++} END{printf "%d %d %d", n, s, m}'`,
  meta: (root: string) => `cat ${root}/${CPG_DIR}/build.json 2>/dev/null || true`,
  markBuilding: (root: string, fp: string) =>
    `mkdir -p ${root}/${CPG_DIR} && printf '{"state":"building","fingerprint":"${fp}"}' > ${root}/${CPG_DIR}/build.json`,
  /** 后台建树：joern-parse 产出 CPG 二进制；done/failed 落标记文件。 */
  buildBg: (root: string, fp: string) =>
    `cd ${root} && nohup sh -c 'rm -rf ${CPG_DIR}/cpg.bin ${CPG_DIR}/build.log; ` +
    `if joern-parse . --output ${CPG_DIR}/cpg.bin > ${CPG_DIR}/build.log 2>&1; then ` +
    `printf "{\\"state\\":\\"ready\\",\\"fingerprint\\":\\"${fp}\\",\\"builtAt\\":%s}" $(date +%s) > ${CPG_DIR}/build.json; ` +
    `else printf "{\\"state\\":\\"failed\\",\\"error\\":\\"joern-parse exited non-zero\\"}" > ${CPG_DIR}/build.json; fi' >/dev/null 2>&1 &`,
  /** 查询：joern --script 执行（joern 4.x：-s 已废弃，会静默掉 REPL 空退 0——
   *  E2E 实校修正）。cwd 故意落在 CPG_DIR 内：importCpg 会把 CPG 拷进
   *  ./workspace/<name>/（joern 4.x 实测 8.5MB×2），落在目标根会污染指纹、
   *  引发重建风暴——落在 .zhishi-cpg 下既被指纹排除也随 CPG 清理。
   *  失败时把 joern log 尾部吐到 stdout（工具据此回注编译错原文给模型自纠）。 */
  queryScript: (root: string, tag: string) =>
    `cd ${root}/${CPG_DIR} && joern --script q-${tag}.sc > q-${tag}.log 2>&1; rc=$?; ` +
    `cat q-${tag}.out 2>/dev/null; if [ $rc -ne 0 ]; then tail -c 1200 q-${tag}.log; fi; ` +
    `rm -f q-${tag}.sc q-${tag}.out q-${tag}.log; exit $rc`,
};

function buildScript(root: string, tag: string, cpgl: string): string {
  // 脚本内容：importCpg 后执行模型查询，逐行输出 {path,line,name} JSON。
  // heredoc 定界引号防 shell 展开——CPGQL 里的 $ 等原样保留。
  return [
    `cat > ${root}/${CPG_DIR}/q-${tag}.sc <<'ZQ_CPGQL_EOF'`,
    '@main def zqmain() = {',
    // joern 4.x：importCpg 返回 Option[Cpg]——.get 解包；None（图缺失）即抛错，
    // 经 exit-code 保真回注为工具错误（E2E 实校）。
    `  val cpg = importCpg("${root}/${CPG_DIR}/cpg.bin").get`,
    `  val res = (${cpgl}).l`,
    '  val pw = new java.io.PrintWriter(new java.io.File(s"' + root + '/' + CPG_DIR + '/q-' + tag + '.out"))',
    '  try {',
    '    res.take(20).foreach { n =>',
    // joern 4.x 实校：节点无 .path/.line/.method 成员（均 E008 编译错）——
    // 统一经 n.location（LocationInfo：filename/lineNumber(Option)/methodShortName）取值。
    '      val (p, l, nm) = try { val loc = n.location; (loc.filename, loc.lineNumber.getOrElse(0), loc.methodShortName) } catch { case _: Throwable => ("", 0, "") }',
    // joern 4.x 实校：脚本 classpath 无 json4s（E008）——手工拼 JSONL。
    '      def esc(s: String): String = s.replace("\\\\", "\\\\\\\\").replace("\\"", "\\\\\\"").replace("\\n", "\\\\n")',
    '      pw.println(s"{\\"path\\":\\"${esc(p)}\\",\\"line\\":$l,\\"name\\":\\"${esc(nm)}\\"}")',
    '    }',
    '  } finally { pw.close() }',
    '}',
    'ZQ_CPGQL_EOF',
  ].join('\n');
}

export function createCodeQueryTool(
  env: EnvironmentEntry,
  deps: { exec?: CodeQueryExec } = {},
): AgentTool<typeof codeQueryParameters> {
  const exec = deps.exec ?? defaultExec(env);

  return {
    name: CODE_QUERY_TOOL_NAME,
    label: '语义代码查询',
    description:
      '在研究环境内对目标代码树做 CPG 语义查询（joern）：数据流/调用图/结构问题一把问，' +
      '返回 file:line + 截断上下文段落——不要用它替代 env_exec 跑命令。' +
      'CPG 按需自动构建（大项目分钟级，构建中返回 building 状态，稍后重试）。' +
      '例（查询以节点遍历结尾，模板自动追加 .l；不要带 .name 等标量投影）' +
      '① 参数溯源 cpg.call("memcpy").argument(2).reachableBy(cpg.call("recv")) ' +
      '② 全部调用点 cpg.method("sctp_m_getptr").callIn ' +
      '③ 结构定位 cpg.type("struct sctp_stream_out")',
    parameters: codeQueryParameters,
    execute: async (_id, params): Promise<AgentToolResult<{ results?: CqResult[]; cpg: Record<string, unknown> }>> => {
      const root = (params.target ?? '.').replace(/"/g, '');
      const action = params.action ?? 'query';
      const timeoutMs = Math.min(
        Math.max((params.timeout_sec ?? QUERY_TIMEOUT_DEFAULT_MS / 1000), 5) * 1000,
        QUERY_TIMEOUT_MAX_MS,
      );

      // 0. joern 在场检查
      const has = await exec(CMD.hasJoern, 10_000);
      if (!has.ok || !has.stdout.includes('yes')) {
        return {
          content: [{ type: 'text', text: 'code_query 需要研究环境内安装 joern（code-audit/pentest 配方自带）。当前环境未找到 joern-parse。' }],
          details: { cpg: { state: 'failed', error: 'joern not found' } },
          isError: true,
        };
      }

      // 1. 指纹 + 元数据 → 状态
      const fpRun = await exec(CMD.fingerprint(root), 30_000);
      const fingerprint = fpRun.ok ? fpRun.stdout.trim() : 'unknown';
      const metaRun = await exec(CMD.meta(root), 10_000);
      let meta: CpgMeta | null = null;
      try { meta = JSON.parse(metaRun.stdout || 'null') as CpgMeta | null; } catch { meta = null; }
      let state = cpgStateFromMeta(meta, fingerprint);

      // 2. ensure_index / 查询前的构建调度
      // 幂等：只有 missing/stale 才真触发后台重建——ensure_index 在 ready 时
      // 必须是 no-op（E2E 实校：每次 ensure 都强推重建会反复阻塞查询窗口）。
      if ((action === 'ensure_index' || action === 'query') && (state === 'missing' || state === 'stale')) {
        await exec(CMD.markBuilding(root, fingerprint), 10_000);
        await exec(CMD.buildBg(root, fingerprint), 10_000);
        state = 'building';
      }
      if (action === 'ensure_index' && state === 'ready') {
        // 幂等 no-op 的明确出口：不携带 query 语义，避免占位 query 被当查询执行。
        return {
          content: [{ type: 'text', text: `CPG 已就绪（fingerprint 一致，ensure_index 为 no-op）` }],
          details: { cpg: { state } },
        };
      }
      if (action === 'status' || state === 'building') {
        return {
          content: [{ type: 'text', text: `CPG ${state === 'building' ? '构建中（joern-parse 后台任务，大项目需数分钟；请用 action:"status" 轮询）' : `状态：${state}`}` }],
          details: { cpg: { state } },
        };
      }
      if (state === 'failed') {
        return {
          content: [{ type: 'text', text: `CPG 构建失败：${(meta as CpgMeta)?.error ?? 'unknown'}。可 action:"ensure_index" 重试或查看 ${root}/${CPG_DIR}/build.log` }],
          details: { cpg: { state: 'failed', error: (meta as CpgMeta)?.error } },
          isError: true,
        };
      }

      // 3. 查询：写脚本 → joern 执行 → 读 JSONL → sed 取上下文 → 截断
      const cpgl = cleanCpgl(params.query);
      const tag = Math.random().toString(36).slice(2, 10);
      const write = await exec(buildScript(root, tag, cpgl), 15_000);
      if (!write.ok) {
        return {
          content: [{ type: 'text', text: `查询脚本写入失败：${write.stderr.slice(0, 200)}` }],
          details: { cpg: { state } },
          isError: true,
        };
      }
      const run = await exec(CMD.queryScript(root, tag), timeoutMs);
      if (!run.ok) {
        // joern 报错原样回注——模型自纠，不吞错（设计稿 §5）
        return {
          content: [{ type: 'text', text: `CPGQL 执行失败（joern 退出码非 0，常见为查询语法错；报错尾部：${run.stdout.slice(-400) || run.stderr.slice(-400)}）` }],
          details: { cpg: { state, raw_tail: (run.stdout + run.stderr).slice(-800) } },
          isError: true,
        };
      }
      const hits = parseJoernJson(run.stdout);
      if (hits.length === 0) {
        return {
          content: [{ type: 'text', text: '查询无命中（0 结果）。检查符号名/语法，或放宽查询。' }],
          details: { cpg: { state }, results: [] },
        };
      }
      // sed 现取上下文窗口（每命中一次，cap 8）——joern 给的 path 相对目标根，
      // 而 env 通道的 cwd 是镜像 WORKDIR（docker exec 无 -w），必须先 cd 回目标根。
      const windows = await Promise.all(hits.slice(0, RESULT_MAX_ITEMS).map(async (h) => {
        const r = await exec(`cd "${root}" && sed -n '${h.line_start},${h.line_start + CONTEXT_LINES}p' "${h.path}" 2>/dev/null | head -c 1500`, 15_000);
        return { ...h, line_end: h.line_start + CONTEXT_LINES, text: r.ok ? r.stdout : '' };
      }));
      const results = truncateResults(windows);
      return {
        content: [{ type: 'text', text: `${results.length} hit(s)${hits.length > RESULT_MAX_ITEMS ? `（共 ${hits.length}，截前 ${RESULT_MAX_ITEMS}）` : ''}：\n` +
          results.map(r => `--- ${r.path}:${r.line_start}${r.symbol ? ` (${r.symbol})` : ''}\n${r.text}`).join('\n') }],
        details: { cpg: { state }, results },
      };
    },
  };
}
