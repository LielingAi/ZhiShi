/**
 * AppCraft action trace — host-side single source of truth for trace.json.
 *
 * Schema is defined by the cuse contract (`specs/tech_docs/appcraft_cuse_contract.md`
 * §4.1); cuse writes recordings (`cuse record --out <dir>/trace.json`) and reads
 * them back for deterministic, LLM-free replay (`cuse replay --trace ... --var k=v`).
 * This module is pure (no I/O, no imports) so it runs in the fast `unit` vitest
 * pool and can be shared by the sidecar (admin-api replay handler) and any
 * future renderer surface.
 *
 * Directory contracts (PRD 0.2.36 §6.4/§6.5):
 *   - recording:  <workspace>/.appcraft/<recordingId>/trace.json + frames/*.png
 *   - skill:      <workspace>/.claude/skills/<name>/{SKILL.md,trace.json,frames/}
 *
 * Replay-time variable substitution happens inside cuse: `{{变量}}` placeholders
 * in locator/params are replaced by `--var` values. `extractVariableCandidates`
 * + `parameterizeTrace` are the host-side helpers the sedimentation flow
 * ("把刚才的流程存成 skill") uses to propose and apply that parameterization.
 */

/** Execution channel recorded per step (contract §4.1). */
export type AppcraftChannel = "uia" | "command" | "vision";

/** UIA locator — all fields optional; matching is lenient on the cuse side. */
export interface AppcraftLocator {
  controlType?: string;
  name?: string;
  automationId?: string;
}

/** Step checkpoint: a verifiable post-condition (contract §4.1). */
export interface AppcraftStepAssert {
  windowTitle?: string;
}

export interface AppcraftTraceStep {
  /** uia_click | uia_set_value | key | click | type | scroll | wait_window (open string — cuse may add actions in newer versions). */
  action: string;
  channel: AppcraftChannel;
  locator?: AppcraftLocator;
  /** Action parameters; coordinates are relative to the bound window's client area. */
  params?: Record<string, unknown>;
  assert?: AppcraftStepAssert;
  /** Failure fallback strategy, e.g. "ai_vision". */
  fallback?: string;
  /** Keyframe screenshot path relative to the trace directory, e.g. "frames/step3.png". */
  keyframe?: string;
  /** True for steps that trigger irreversible/outbound effects (submit/delete/
   * send/pay/overwrite…). Replay refuses to run them unless explicitly
   * approved (`allowHighRisk`), per PRD §6.8. */
  highRisk?: boolean;
}

// ---------------------------------------------------------------------------
// Step risk classification (PRD §6.8 — high-risk step approval)
// ---------------------------------------------------------------------------

/** Labels that mark a step as irreversible/outbound when found in locator
 * names or typed values. Chinese-first with common English variants. */
const HIGH_RISK_PATTERN = /删除|清空|发送|提交|确认|确定|支付|转账|覆盖|删除文件|发布|下单|delete|remove|send|submit|confirm|ok|pay|transfer|overwrite|publish|order/i;

/** Free-text params that often carry outbound content (typed into forms). */
const TEXT_PARAM_KEYS = ['text', 'value', 'text_to_type'];

/**
 * Classify a trace step's risk. v1 is deliberately simple: a step is high-risk
 * when its locator name (button/menu label) or typed text matches the
 * irreversible/outbound pattern. Conservative on false positives (an "OK"
 * button match is acceptable friction for an unattended replay).
 */
export function classifyStepRisk(step: AppcraftTraceStep): 'normal' | 'high' {
  const candidates: string[] = [];
  if (typeof step.locator?.name === 'string') candidates.push(step.locator.name);
  const params = step.params;
  if (params) {
    for (const key of TEXT_PARAM_KEYS) {
      const v = params[key];
      if (typeof v === 'string') candidates.push(v);
    }
  }
  return candidates.some((c) => HIGH_RISK_PATTERN.test(c)) ? 'high' : 'normal';
}

export interface AppcraftTrace {
  /** Schema version. Currently 1 (contract §4.1). */
  version: number;
  /** BoundApp.id the trace was recorded against (legacy), or the process name
   * for zero-config recordings. */
  app: string;
  /** Self-contained target identity (design C): everything the replay needs to
   * resolve the app without consulting boundApps — process for scoping, exe
   * for auto-launch, windowTitle as a secondary matcher. */
  appInfo?: AppcraftAppInfo;
  /** ISO 8601 timestamp. */
  recordedAt: string;
  steps: AppcraftTraceStep[];
}

/** Self-contained bound-app identity embedded in a trace (design C). */
export interface AppcraftAppInfo {
  /** Process scope for terminator selector calls (e.g. "notepad"). */
  process?: string;
  /** Executable path for auto-launch at replay start. */
  exe?: string;
  /** Window title match pattern (secondary matcher, supports * wildcard). */
  windowTitle?: string;
}

/**
 * A literal suspected to be a per-run variable (date, month, amount, quoted
 * text, file name) found in locator/params. `placeholder` is the proposed
 * `{{变量}}` name, `original` the literal to replace, `stepIndexes` every step
 * where the literal occurs.
 */
export interface VariableCandidate {
  placeholder: string;
  original: string;
  stepIndexes: number[];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const KNOWN_CHANNELS: ReadonlySet<string> = new Set([
  "uia",
  "command",
  "vision",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function pickString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = record[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * Fast structural probe: has a numeric `version` and a `steps` array. Used to
 * distinguish an AppCraft trace.json from any other JSON before committing to
 * a full parse.
 */
export function isAppcraftTrace(json: unknown): boolean {
  const record = asRecord(json);
  return (
    !!record &&
    typeof record.version === "number" &&
    Array.isArray(record.steps)
  );
}

/**
 * Tolerant parse. Returns null only when the value is structurally not a
 * trace (not an object / no numeric version / no steps array). Everything
 * else degrades field-by-field: missing app/recordedAt become '', unknown
 * channels are preserved as-is, malformed steps are dropped, non-object
 * locator/params/assert are omitted. A trace that lost every step still
 * parses (empty steps is a legal — if useless — recording).
 */
export function parseAppcraftTrace(json: unknown): AppcraftTrace | null {
  if (!isAppcraftTrace(json)) return null;
  const record = json as Record<string, unknown>;

  const steps: AppcraftTraceStep[] = [];
  for (const rawStep of record.steps as unknown[]) {
    const step = parseStep(rawStep);
    if (step) steps.push(step);
  }

  const appInfoRecord = asRecord(record.appInfo);
  const appInfo = appInfoRecord
    ? {
        process: pickString(appInfoRecord, "process"),
        exe: pickString(appInfoRecord, "exe"),
        windowTitle: pickString(appInfoRecord, "windowTitle"),
      }
    : undefined;

  return {
    version: record.version as number,
    app: pickString(record, "app") ?? "",
    ...(appInfo && (appInfo.process || appInfo.exe || appInfo.windowTitle) ? { appInfo } : {}),
    recordedAt: pickString(record, "recordedAt") ?? "",
    steps,
  };
}

function parseStep(raw: unknown): AppcraftTraceStep | null {
  const record = asRecord(raw);
  if (!record) return null;
  const action = pickString(record, "action");
  if (!action) return null;

  const rawChannel = pickString(record, "channel");
  const channel: AppcraftChannel =
    rawChannel && KNOWN_CHANNELS.has(rawChannel)
      ? (rawChannel as AppcraftChannel)
      : "vision";

  const step: AppcraftTraceStep = { action, channel };

  const locator = asRecord(record.locator);
  if (locator) {
    step.locator = {
      controlType: pickString(locator, "controlType"),
      name: pickString(locator, "name"),
      automationId: pickString(locator, "automationId"),
    };
  }

  const params = asRecord(record.params);
  if (params) step.params = params;

  const assert = asRecord(record.assert);
  if (assert) {
    step.assert = { windowTitle: pickString(assert, "windowTitle") };
  }

  const fallback = pickString(record, "fallback");
  if (fallback) step.fallback = fallback;

  const keyframe = pickString(record, "keyframe");
  if (keyframe) step.keyframe = keyframe;

  return step;
}

// ---------------------------------------------------------------------------
// Variable candidate extraction
// ---------------------------------------------------------------------------

/** Placeholder base names by content type (Chinese — matches user-facing confirmation lists). */
const TYPE_LABELS = {
  date: "日期",
  month: "月份",
  amount: "金额",
  filename: "文件名",
  text: "文本",
} as const;

type CandidateType = keyof typeof TYPE_LABELS;

interface MatchSpan {
  start: number;
  end: number;
  type: CandidateType;
  original: string;
}

// Full date: 2026-06-30 / 2026/6/3 / 2026年6月30日. Checked first so the
// month pattern can't claim the "2026-06" prefix of a longer date.
const DATE_RE = /20\d{2}[-/年]\s?\d{1,2}[-/月]\s?\d{1,2}日?/g;
// Year-month: 2026-06 / 2026/6 / 2026年6月 (trailing 月 optional for the 年 form).
const MONTH_RE = /20\d{2}[-/年]\s?\d{1,2}月?/g;
// Amount: ¥1,234.50 / ￥88 / 3500元 / 12,000 (thousands separators imply money).
const AMOUNT_RE =
  /[¥￥]\s?\d[\d,]*(?:\.\d+)?|\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?\s?元/g;
// File name with a common document/media/archive extension. No spaces in the
// character class — otherwise the match greedily extends left across the whole
// sentence ("保存为 报表.xlsx" becomes the "filename") and swallows dates/
// months that legitimately precede the real name.
const FILENAME_RE =
  /[\p{L}\p{N}_\-（）()]{1,80}\.(?:xlsx?|docx?|pptx?|pdf|csv|txt|png|jpe?g|gif|zip|json|log)/giu;
// Quoted string: paired ASCII or CJK quotes; inner content becomes the candidate.
const QUOTED_RE = /["'“‘「]([^"'“”‘’」\n]{1,80})["'“”’」]/g;

/** Placeholders already parameterized must not be re-detected as variables. */
const PLACEHOLDER_RE = /\{\{[^{}]+\}\}/;

function collectSpans(value: string): MatchSpan[] {
  const spans: MatchSpan[] = [];
  const pushMatches = (re: RegExp, type: CandidateType, group = 0): void => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(value)) !== null) {
      const original = type === "text" ? m[1] : m[group];
      if (!original || PLACEHOLDER_RE.test(original)) continue;
      const start = type === "text" ? m.index + m[0].indexOf(m[1]) : m.index;
      spans.push({ start, end: start + original.length, type, original });
    }
  };

  // Priority order matters: earlier claims win on overlap (a date contains a
  // year-month; a filename may contain a date; a quoted string may wrap any).
  pushMatches(DATE_RE, "date");
  pushMatches(MONTH_RE, "month");
  pushMatches(AMOUNT_RE, "amount");
  pushMatches(FILENAME_RE, "filename");
  pushMatches(QUOTED_RE, "text");

  // Drop spans that overlap an earlier (higher-priority) span.
  const accepted: MatchSpan[] = [];
  for (const span of spans) {
    const overlaps = accepted.some(
      (s) => span.start < s.end && s.start < span.end,
    );
    if (!overlaps) accepted.push(span);
  }
  return accepted;
}

/** Enumerate every string leaf under value (objects/arrays recursed). */
function visitStrings(value: unknown, visit: (s: string) => void): void {
  if (typeof value === "string") {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) visitStrings(item, visit);
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>))
      visitStrings(v, visit);
  }
}

/**
 * Scan locator/params of every step for literals that look like per-run
 * variables: dates, year-months, monetary amounts, quoted strings, file names.
 * Results are deduplicated by (type, original) with merged stepIndexes, and
 * placeholders are numbered per type (`{{月份}}`, `{{月份2}}`, …) in first-seen
 * order. This is a *proposal* list — the sedimentation flow always confirms
 * with the user before applying it (PRD §6.5).
 */
export function extractVariableCandidates(
  trace: AppcraftTrace,
): VariableCandidate[] {
  const byKey = new Map<
    string,
    { type: CandidateType; original: string; stepIndexes: number[] }
  >();

  trace.steps.forEach((step, stepIndex) => {
    const seenInStep = new Set<string>();
    const handle = (value: string): void => {
      for (const span of collectSpans(value)) {
        const key = `${span.type}${span.original}`;
        if (seenInStep.has(key)) continue;
        seenInStep.add(key);
        const entry = byKey.get(key);
        if (entry) {
          entry.stepIndexes.push(stepIndex);
        } else {
          byKey.set(key, {
            type: span.type,
            original: span.original,
            stepIndexes: [stepIndex],
          });
        }
      }
    };
    if (step.locator) visitStrings(step.locator, handle);
    if (step.params) visitStrings(step.params, handle);
  });

  const counters = new Map<CandidateType, number>();
  const candidates: VariableCandidate[] = [];
  for (const { type, original, stepIndexes } of byKey.values()) {
    const count = (counters.get(type) ?? 0) + 1;
    counters.set(type, count);
    const label = TYPE_LABELS[type];
    candidates.push({
      placeholder: `{{${count > 1 ? `${label}${count}` : label}}}`,
      original,
      stepIndexes,
    });
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Parameterization
// ---------------------------------------------------------------------------

/** Normalize a mapping value to `{{name}}` form (accepts both "月份" and "{{月份}}"). */
function toPlaceholder(value: string): string {
  const trimmed = value.trim();
  return PLACEHOLDER_RE.test(trimmed) ? trimmed : `{{${trimmed}}}`;
}

function replaceInValue(
  value: unknown,
  replacers: Array<{ original: string; placeholder: string }>,
): unknown {
  if (typeof value === "string") {
    let out = value;
    for (const { original, placeholder } of replacers) {
      if (original && out.includes(original))
        out = out.split(original).join(placeholder);
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceInValue(item, replacers));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = replaceInValue(v, replacers);
    }
    return out;
  }
  return value;
}

/**
 * Apply literal→placeholder substitution across every step's locator and
 * params (the two scopes cuse substitutes `--var` values into at replay time —
 * contract §4.3). `mapping` keys are original literals; values are variable
 * names with or without `{{}}` braces. `assert` is intentionally untouched:
 * checkpoints verify window state, not user data, and cuse does not
 * substitute there either.
 *
 * Returns a new trace; the input is not mutated. Longer literals are replaced
 * first so a date ("2026-06-30") wins over its month prefix ("2026-06").
 */
export function parameterizeTrace(
  trace: AppcraftTrace,
  mapping: Record<string, string>,
): AppcraftTrace {
  const replacers = Object.entries(mapping)
    .filter(([original, name]) => original && name.trim())
    .map(([original, name]) => ({ original, placeholder: toPlaceholder(name) }))
    .sort((a, b) => b.original.length - a.original.length);

  return {
    ...trace,
    steps: trace.steps.map((step) => ({
      ...step,
      locator: step.locator
        ? (replaceInValue(step.locator, replacers) as AppcraftLocator)
        : undefined,
      params: step.params
        ? (replaceInValue(step.params, replacers) as Record<string, unknown>)
        : undefined,
    })),
  };
}
