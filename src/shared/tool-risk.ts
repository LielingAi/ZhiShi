/**
 * Tool-call risk classification — pure decision core.
 *
 * WHY THIS EXISTS
 * ---------------
 * Headless / 无人值守会话（IM 场景、fullAgency 权限档）不能挂起等人点审批卡：
 * canUseTool 的 fast-path 用三级风险表决定自动放行还是落应答队列：
 *
 *   low    (read-only)            → auto-allow
 *   medium (reversible write)     → auto-allow
 *   high   (irreversible/egress)  → 落本地应答队列（IM 审批 / 权限卡）
 *
 *（PRD 0.2.36 的 Hub escalation 通道已随 Team Hub 客户端一并移除，2026-08-06。）
 *
 * This module is the single source of truth for the risk table and for the
 * normalized tool-call signature. It is pure (no I/O, no imports from server
 * singletons) so it runs in the fast `unit` vitest pool; consumers live in
 * agent-session.ts（fullAgency / IM fast-path 风险分级）。
 *
 * CONSERVATIVE DEFAULT
 * --------------------
 * Anything we cannot PROVE safe is 'high'. A false positive costs one extra
 * approval intervention (and §6.6 "always allow" dedups repeats); a false
 * negative silently executes an irreversible action with nobody watching.
 * Asymmetry is deliberate.
 */

/** Risk levels per PRD §6.5. */
export type ToolRisk = 'low' | 'medium' | 'high';

/**
 * Read-only builtin tools: no filesystem/network mutation, safe to run
 * unattended. Mirrors PLAN_MODE_READONLY_TOOLS (Read/Glob/Grep/LS) and adds
 * WebSearch/WebFetch (egress but GET-only, no state change — the PRD §6.5
 * table lists WebSearch as the low-risk example; WebFetch is the same shape),
 * plus Task (sub-agent delegation is gated again inside the child) and the
 * Todo bookkeeping tools (in-memory plan state only).
 *
 * AskUserQuestion / EnterPlanMode / ExitPlanMode are also classified 'low'
 * NOT because they are read-only but because they are control-transfer tools
 * with their own dedicated handlers later in canUseTool — escalating them to
 * a Hub intervention would break those handlers' `interrupt` semantics.
 * 'low' here means "passthrough, existing path stays authoritative".
 */
const LOW_RISK_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'WebSearch',
  'WebFetch',
  'Task',
  'TodoWrite',
  'TodoRead',
  'NotebookRead',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
]);

/**
 * Reversible-write tools: they mutate the workspace, but the mutation is
 * local, scoped to files the task owns, and recoverable (git / file history /
 * rewind). Per PRD §6.5 these auto-allow with an audit line instead of an
 * intervention. Skill is included: skills are user-installed, reviewed
 * prompt/asset bundles whose own tool calls are gated individually.
 */
const MEDIUM_RISK_TOOLS: ReadonlySet<string> = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Skill',
]);

// ---------------------------------------------------------------------------
// `zhishi` CLI risk surface
// ---------------------------------------------------------------------------
//
// After the v0.2.11 cron / im-cron / im-media → CLI migration, the AI drives
// ZhiShi's own scheduling / IM / widget surface through `zhishi <group> …`
// Bash invocations. The read-only patterns below are SEMANTIC COPIES of the
// auto-allow regexes in agent-session.ts's canUseTool (they are the same
// contract: whitespace restricted to space+tab so `\n` can't smuggle a second
// command, strict token character classes so shell metachars fail the match).
// agent-session.ts imports these constants for its auto-allow fast-path so
// the two can never drift apart.

/** `zhishi widget [readme|list|<module>] [<module>...]` — module slugs only. */
export const ZHISHI_WIDGET_READONLY_PATTERN =
  /^zhishi[ \t]+widget(?:[ \t]+(?:readme|list))?(?:[ \t]+[a-z][a-z0-9-]*)*[ \t]*$/;

/** `zhishi memory search '<query>' [--kind <slug,slug>] [--limit N] [--json]`.
 *  Query 必须是单引号字面量（`[^']*`）——bash 单引号不插值，与 widget readme 同防线；
 *  双引号 / 无引号形式落到正常确认流。检索本身只读（recall 日志是内部记账，无外部副作用）。 */
export const ZHISHI_MEMORY_SEARCH_PATTERN =
  /^zhishi[ \t]+memory[ \t]+search[ \t]+'[^']*'(?:[ \t]+(?:--kind[ \t]+[a-z,]{1,64}|--limit[ \t]+\d{1,4}|--json))*[ \t]*$/;

/** All read-only `zhishi` CLI forms, in the order agent-session checks them. */
export const ZHISHI_READONLY_BASH_PATTERNS: readonly RegExp[] = [
  ZHISHI_WIDGET_READONLY_PATTERN,
  ZHISHI_MEMORY_SEARCH_PATTERN,
];

// ---------------------------------------------------------------------------
// Bash danger patterns
// ---------------------------------------------------------------------------

/**
 * Destructive filesystem / disk commands: rm, del, erase, rd, rmdir,
 * Remove-Item, format, mkfs, dd. Word-boundary matched case-insensitively.
 * Known false positive: `npm run format` (prettier) also matches — accepted,
 * because unmatched Bash commands default to HIGH anyway, so the label only
 * affects the signature category, not the decision.
 */
const DESTRUCTIVE_PATTERN = /\b(?:rm|del|erase|rd|rmdir|format|mkfs|dd)\b|\bRemove-Item\b/i;

/** `git push` — publishes local history to a remote; cannot be un-pushed cleanly. */
const GIT_PUSH_PATTERN = /^\s*git(?:\.exe)?[ \t]+[^;|&]*\bpush\b/i;

/**
 * Network egress with a payload: `curl -X POST/PUT/DELETE/PATCH`, `curl -d/--data`,
 * and the PowerShell equivalents (`Invoke-WebRequest`/`Invoke-RestMethod`/aliases
 * with `-Method Post…` or `-Body`). GET-only fetches are NOT matched — they fall
 * to the conservative 'other' bucket (still high, different signature category).
 */
const NET_POST_PATTERN =
  /\b(?:curl|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|wget)\b[^;|&]*(?:-X\s*(?:POST|PUT|DELETE|PATCH)\b|-X(?:POST|PUT|DELETE|PATCH)\b|--data|-d\s|-Method\s*(?:Post|Put|Delete|Patch)\b|-Body\s)/i;

/** Danger categories, embedded into Bash signatures for §6.6 "always allow" scoping. */
export type BashDangerCategory =
  | 'zhishi-mutating'
  | 'destructive'
  | 'git-push'
  | 'net-post'
  | 'other';

interface BashClassification {
  risk: ToolRisk;
  category: BashDangerCategory | null;
}

/**
 * Classify a Bash command string. Exported for testing; `classifyToolRisk`
 * is the public entry point.
 *
 * Everything unmatched is HIGH — the conservative default for
 * unclassifiable commands.
 */
export function classifyBashCommand(command: string): BashClassification {
  const cmd = command.trim();
  if (!cmd) {
    // Empty command: no effect, but treat as low rather than burn an intervention.
    return { risk: 'low', category: null };
  }
  for (const pattern of ZHISHI_READONLY_BASH_PATTERNS) {
    if (pattern.test(cmd)) return { risk: 'low', category: null };
  }
  if (GIT_PUSH_PATTERN.test(cmd)) return { risk: 'high', category: 'git-push' };
  if (DESTRUCTIVE_PATTERN.test(cmd)) return { risk: 'high', category: 'destructive' };
  if (NET_POST_PATTERN.test(cmd)) return { risk: 'high', category: 'net-post' };
  // Conservative default: we could not prove this command safe.
  return { risk: 'high', category: 'other' };
}

/**
 * Classify a tool call into the §6.5 three-level risk table.
 *
 * MCP tools (`mcp__<server>__<tool>`) are HIGH unless context-injected (those
 * never reach classification — canUseTool auto-allows them earlier): an MCP
 * name carries no read/write semantics, so the conservative default applies.
 * The one exception is WebFetch, which is a builtin, not an MCP tool.
 */
export function classifyToolRisk(toolName: string, input: unknown): ToolRisk {
  if (toolName === 'Bash') {
    const command =
      typeof (input as Record<string, unknown> | null)?.command === 'string'
        ? ((input as Record<string, unknown>).command as string)
        : '';
    return classifyBashCommand(command).risk;
  }
  if (LOW_RISK_TOOLS.has(toolName)) return 'low';
  if (MEDIUM_RISK_TOOLS.has(toolName)) return 'medium';
  // Unknown builtins and all third-party mcp__* tools: cannot prove safe.
  return 'high';
}

// ---------------------------------------------------------------------------
// §6.6 normalized tool-call signature
// ---------------------------------------------------------------------------

/**
 * Normalize a filesystem path for signature use: forward slashes, lowercase
 * (Windows/macOS default case-insensitive), collapse duplicate slashes and
 * trailing slash. Deliberately NOT resolved against cwd — the signature is a
 * dedup key, not a security check; two spellings of the same path collapsing
 * together is desirable, and two different paths colliding is harmless (the
 * grant is session-scoped and the tool is medium-risk anyway).
 */
function normalizePathForSignature(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** First command word of a Bash line, normalized (basename, no .exe, lowercase). */
function bashFirstWord(command: string): string {
  const firstSegment = command.trim().split(/&&|\|\||[;|]/)[0] ?? '';
  const firstToken = firstSegment.trim().split(/[ \t]+/)[0] ?? '';
  const base = firstToken.replace(/\\/g, '/').split('/').pop() ?? '';
  return base.replace(/\.exe$/i, '').toLowerCase() || 'unknown';
}

/**
 * Normalized signature for §6.6 dedup + session-scoped "总是允许":
 *
 *   Bash            → `bash:<firstWord>:<dangerCategory>`
 *                     e.g. `bash:rm:destructive`, `bash:git:git-push`,
 *                     `bash:zhishi:zhishi-mutating`, `bash:npm:other`.
 *                     Deliberately coarse: approving `rm -rf a/` also covers
 *                     `rm -rf b/` in the same session — that IS the "总是允许
 *                     同类操作" semantic the PRD asks for (deleting 50 files =
 *                     1 intervention, not 50).
 *   Write/Edit/…    → `<tool>:<normalizedPath>` (per-file grants).
 *   mcp__a__b       → the full tool name (already server+tool specific).
 *   everything else → the tool name.
 *
 * Stability contract: same (toolName, input) → same string, across processes
 * and platforms. Used as a Map key only; never parsed back.
 */
export function toolCallSignature(toolName: string, input: unknown): string {
  if (toolName === 'Bash') {
    const command =
      typeof (input as Record<string, unknown> | null)?.command === 'string'
        ? ((input as Record<string, unknown>).command as string)
        : '';
    const { category } = classifyBashCommand(command);
    if (!category) {
      // Read-only zhishi / empty command — these never escalate; give them a
      // stable signature anyway so callers can use one code path.
      return `bash:${bashFirstWord(command)}:readonly`;
    }
    return `bash:${bashFirstWord(command)}:${category}`;
  }
  const filePath =
    typeof (input as Record<string, unknown> | null)?.file_path === 'string'
      ? ((input as Record<string, unknown>).file_path as string)
      : typeof (input as Record<string, unknown> | null)?.notebook_path === 'string'
        ? ((input as Record<string, unknown>).notebook_path as string)
        : null;
  if (filePath && MEDIUM_RISK_TOOLS.has(toolName)) {
    return `${toolName}:${normalizePathForSignature(filePath)}`;
  }
  return toolName;
}
