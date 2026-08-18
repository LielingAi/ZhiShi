/**
 * AppCraft replay orchestration (PRD 0.2.36 §6.6, contract
 * specs/tech_docs/appcraft_engine_contract.md §2/§4): zero-LLM replay of a
 * parsed trace.json by driving terminator MCP tools step-by-step (UIA
 * semantic channel) with cuse CLI atoms as the vision fallback.
 *
 * This module is deliberately free of any binary-path / process-spawn logic:
 * the terminator side is an injectable `ReplayToolClient` (terminator-client.ts
 * in production, a fake in unit tests) and the cuse side is an injectable
 * `CuseRunner` (admin-api's runCuse). That keeps the module pure enough for
 * the fast `unit` vitest pool.
 *
 * Step mapping (contract §2):
 *   uia_click      → terminator invoke_element   (InvokePattern, background-safe)
 *   uia_set_value  → terminator set_value
 *   key            → terminator press_key        (vision channel → cuse key)
 *   click          → cuse click <x> <y>
 *   type           → cuse type <text>
 *   scroll         → cuse scroll <direction> <amount>
 *   wait_window    → terminator wait_for_element (locator present) else delay
 *
 * Failure semantics (PRD §6.6 acceptance): any step failure or assert failure
 * aborts the replay and reports the failed step index + reason + locator. A
 * step that declared `fallback: 'ai_vision'` additionally flags
 * `requiresAiHeal` so the AI self-heal flow (PRD §6.7) can take over.
 */
import type {
  AppcraftChannel,
  AppcraftLocator,
  AppcraftStepAssert,
  AppcraftTrace,
  AppcraftTraceStep,
} from '../../shared/appcraft-trace';
import type { BoundApp } from '../../shared/config-types';

// ---------------------------------------------------------------------------
// Injectable collaborators
// ---------------------------------------------------------------------------

/** Minimal surface the engine needs from a terminator MCP client. */
export interface ReplayToolClient {
  callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}

export interface CuseRunOutcome {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  spawnError?: string;
}

/** Runs one cuse CLI atom (`cuse click 100 200`, `cuse type hello`, …). */
export type CuseRunner = (args: string[]) => Promise<CuseRunOutcome>;

// ---------------------------------------------------------------------------
// Selector / process helpers
// ---------------------------------------------------------------------------

/**
 * Build a terminator selector from a trace locator (contract §1 syntax):
 * automationId wins (`nativeid:<id>` — most stable), otherwise
 * `role:<controlType> && name:<name>` with either part optional.
 * Returns null when the locator carries no usable field.
 */
export function buildTerminatorSelector(locator?: AppcraftLocator): string | null {
  if (!locator) return null;
  if (locator.automationId) return `nativeid:${locator.automationId}`;
  const parts: string[] = [];
  if (locator.controlType) parts.push(`role:${locator.controlType}`);
  if (locator.name) parts.push(`name:${locator.name}`);
  return parts.length > 0 ? parts.join(' && ') : null;
}

/** exe path → terminator `process` scope: basename minus the .exe suffix. */
export function deriveProcessName(exe: string): string {
  const base = exe.split(/[\\/]/).pop() ?? exe;
  return base.replace(/\.exe$/i, '');
}

/**
 * The bound app a trace was recorded against: match `trace.app` against
 * BoundApp.id, then display name; a single bound app is used as the implicit
 * default. undefined = no process scope available (UIA steps cannot plan).
 */
export function resolveBoundAppForTrace(trace: AppcraftTrace, boundApps: BoundApp[]): BoundApp | undefined {
  return (
    boundApps.find((a) => a.id === trace.app) ??
    boundApps.find((a) => a.name === trace.app) ??
    (boundApps.length === 1 ? boundApps[0] : undefined)
  );
}

function resolveProcessName(trace: AppcraftTrace, boundApps: BoundApp[]): string | undefined {
  // Design C: the trace's own identity wins — zero-config recordings carry
  // process/exe directly. Legacy boundApp lookup is the fallback.
  if (trace.appInfo?.process) return trace.appInfo.process;
  const app = resolveBoundAppForTrace(trace, boundApps);
  return app ? deriveProcessName(app.exe) : undefined;
}

// ---------------------------------------------------------------------------
// Variable substitution (--var 月份=2026-06 → {{月份}} placeholders)
// ---------------------------------------------------------------------------

const PLACEHOLDER_RE = /\{\{([^{}]+)\}\}/g;

function substituteString(value: string, vars: Record<string, string>): string {
  return value.replace(PLACEHOLDER_RE, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : whole,
  );
}

function substituteValue(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === 'string') return substituteString(value, vars);
  if (Array.isArray(value)) return value.map((item) => substituteValue(item, vars));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substituteValue(v, vars);
    }
    return out;
  }
  return value;
}

/**
 * Replace `{{变量}}` placeholders in locator + params with --var values.
 * `assert` is intentionally untouched (same scope rule as parameterizeTrace);
 * unknown placeholders are left as-is so a missing --var fails loudly at the
 * tool layer instead of being silently blanked.
 */
export function substituteVarsInStep(step: AppcraftTraceStep, vars: Record<string, string>): AppcraftTraceStep {
  if (Object.keys(vars).length === 0) return step;
  return {
    ...step,
    locator: step.locator ? (substituteValue(step.locator, vars) as AppcraftLocator) : undefined,
    params: step.params ? (substituteValue(step.params, vars) as Record<string, unknown>) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * terminator action tools require these params (contract §1 quirks);
 * disabling tree/screenshot/window-management turns 10-30s calls into
 * sub-second ones — the replay speed critical path.
 */
export const TERMINATOR_ACTION_DEFAULTS = {
  verify_element_exists: '',
  verify_element_not_exists: '',
  highlight_before_action: true,
  ui_diff_before_after: false,
  include_tree_after_action: false,
  include_window_screenshot: false,
  // 02b9fec 曾把窗口管理默认打开（bring window front），实测证明这是回归：
  // terminator 的 Win32 窗口枚举对 Win11 新记事本等窗口报 'Could not find
  // Win32 window'，导致动作反而 Element not found。UIA InvokePattern 本来就
  // 不要求窗口在前台——动作工具默认关闭窗口管理，前台化交给 open_application
  // （launch 路径保留 WM）和 prefetch 的窗口存在性校验。
  enable_window_management: false,
  // 实测（2026-07-21）：invoke/set_value 的默认元素搜索深度太浅（notepad 实测
  // 只返回 17 个元素，菜单位于更深层的 MenuBar 子树），selector 明明存在却报
  // Element not found。必须显式给足深度。
  tree_max_depth: 30,
} as const;

export type PlannedCall =
  | { kind: 'terminator'; tool: string; args: Record<string, unknown> }
  | { kind: 'cuse'; args: string[] }
  | { kind: 'delay'; ms: number }
  | { kind: 'unsupported'; reason: string };

export interface PlannedStep {
  stepIndex: number;
  action: string;
  channel: AppcraftChannel;
  locator?: AppcraftLocator;
  assert?: AppcraftStepAssert;
  fallback?: string;
  /** Propagated from the trace step (PRD §6.8 high-risk approval gate). */
  highRisk?: boolean;
  call: PlannedCall;
}

function unsupported(reason: string): PlannedCall {
  return { kind: 'unsupported', reason };
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

/** Shared planning for UIA element actions (invoke_element / set_value). */
function terminatorElementCall(
  tool: 'invoke_element' | 'set_value',
  step: AppcraftTraceStep,
  processName: string | undefined,
): PlannedCall {
  const selector = buildTerminatorSelector(step.locator);
  if (!selector) return unsupported(`action '${step.action}' requires a locator (controlType/name/automationId)`);
  if (!processName) return unsupported(`action '${step.action}' requires a bound app (process scope)`);
  const args: Record<string, unknown> = {
    process: processName,
    selector,
    ...TERMINATOR_ACTION_DEFAULTS,
  };
  if (tool === 'set_value') {
    // params.text is the recorder's alias for type_into_element (text input
    // semantics) — accept both so recorded traces replay unchanged.
    const value = step.params?.value ?? step.params?.text;
    if (value === undefined || value === null) return unsupported("action 'uia_set_value' requires params.value");
    args.value = typeof value === 'string' ? value : String(value);
  }
  return { kind: 'terminator', tool, args };
}

function planCall(step: AppcraftTraceStep, processName: string | undefined): PlannedCall {
  const params = step.params ?? {};
  switch (step.action) {
    case 'uia_click': {
      // Index-based click (from get_window_tree indices)
      const index = asNumber(params.index);
      if (index !== undefined) {
        if (!processName) return unsupported("action 'uia_click' with index requires a bound app (process scope)");
        return {
          kind: 'terminator',
          tool: 'click_element',
          args: {
            index,
            process: processName,
            vision_type: firstString(params.vision_type) ?? 'ui_tree',
            ...TERMINATOR_ACTION_DEFAULTS,
          },
        };
      }
      // Coordinate-based click (params.x / params.y)
      const x = asNumber(params.x);
      const y = asNumber(params.y);
      if (x !== undefined && y !== undefined) {
        return {
          kind: 'terminator',
          tool: 'click_element',
          args: { x, y, ...TERMINATOR_ACTION_DEFAULTS },
        };
      }
      // Selector-based invoke (default)
      return terminatorElementCall('invoke_element', step, processName);
    }

    case 'uia_set_value':
      return terminatorElementCall('set_value', step, processName);

    case 'key': {
      const combo = firstString(params.key, params.combo, params.keys);
      if (!combo) return unsupported("action 'key' requires params.key");
      // Vision channel stays on cuse so a pure-vision trace never needs terminator.
      if (step.channel === 'vision') return { kind: 'cuse', args: ['key', combo] };
      if (!processName) return unsupported("action 'key' requires a bound app (process scope)");
      const selector = buildTerminatorSelector(step.locator);
      if (selector) {
        return {
          kind: 'terminator',
          tool: 'press_key',
          args: { process: processName, selector, key: combo, ...TERMINATOR_ACTION_DEFAULTS },
        };
      }
      // No selector → use press_key_global (targets the window itself, no element lookup).
      return {
        kind: 'terminator',
        tool: 'press_key_global',
        args: { process: processName, key: combo, verify_element_exists: '', verify_element_not_exists: '', ui_diff_before_after: false },
      };
    }

    case 'click': {
      const x = asNumber(params.x);
      const y = asNumber(params.y);
      if (x === undefined || y === undefined) return unsupported("action 'click' requires params.x/params.y");
      return { kind: 'cuse', args: ['click', String(x), String(y)] };
    }

    case 'type': {
      const text = firstString(params.text, params.value);
      if (text === undefined) return unsupported("action 'type' requires params.text");
      return { kind: 'cuse', args: ['type', text] };
    }

    case 'scroll': {
      const direction = firstString(params.direction) ?? 'down';
      const amount = asNumber(params.amount) ?? 3;
      return { kind: 'cuse', args: ['scroll', direction, String(amount)] };
    }

    case 'wait_window': {
      const selector = buildTerminatorSelector(step.locator);
      if (step.channel !== 'vision' && selector && processName) {
        return {
          kind: 'terminator',
          tool: 'wait_for_element',
          args: {
            process: processName,
            selector,
            timeout_ms: asNumber(params.timeoutMs) ?? asNumber(params.ms) ?? 10_000,
            include_window_screenshot: false,
          },
        };
      }
      // No UIA handle on the target window → plain delay fallback.
      return { kind: 'delay', ms: asNumber(params.ms) ?? asNumber(params.timeoutMs) ?? 1000 };
    }

    default:
      return unsupported(`unsupported action '${step.action}'`);
  }
}

/** Plan every step (variable substitution + tool mapping) without executing anything. */
export function planReplay(
  trace: AppcraftTrace,
  vars: Record<string, string> = {},
  boundApps: BoundApp[] = [],
): PlannedStep[] {
  const processName = resolveProcessName(trace, boundApps);
  return trace.steps.map((raw, stepIndex) => {
    const step = substituteVarsInStep(raw, vars);
    return {
      stepIndex,
      action: step.action,
      channel: step.channel,
      locator: step.locator,
      assert: step.assert,
      fallback: step.fallback,
      highRisk: step.highRisk,
      call: planCall(step, processName),
    };
  });
}

/** true when at least one step drives a terminator MCP tool. */
export function planNeedsTerminator(plan: PlannedStep[]): boolean {
  return plan.some((p) => p.call.kind === 'terminator');
}

/** true when at least one step drives a cuse CLI atom. */
export function planNeedsCuse(plan: PlannedStep[]): boolean {
  return plan.some((p) => p.call.kind === 'cuse');
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface ReplayStepResult {
  stepIndex: number;
  action: string;
  /** Channel declared at recording time. */
  channel: AppcraftChannel;
  /** Engine actually used for this step (vision step → 'cuse', wait fallback → 'delay'). */
  actualChannel: 'terminator' | 'cuse' | 'delay' | 'none';
  /** terminator tool name, or `cuse <atom>` for vision steps. */
  tool?: string;
  status: 'ok' | 'failed';
  durationMs: number;
  error?: string;
  /** assert outcome — 'unverified' when there was no honest way to check (never faked). */
  assert?: 'passed' | 'failed' | 'unverified';
  warnings: string[];
}

export interface ReplayFailure {
  stepIndex: number;
  action: string;
  reason: string;
  locator?: AppcraftLocator;
  fallback?: string;
  /** true when the failed step declared `fallback: 'ai_vision'` → hand to AI self-heal (PRD §6.7). */
  requiresAiHeal: boolean;
  /** true when the step was blocked by the high-risk approval gate (PRD §6.8)
   * — ask a human, then retry with allowHighRisk. */
  requiresApproval?: boolean;
}

export interface ReplayReport {
  status: 'completed' | 'failed';
  app: string;
  stepCount: number;
  /** Steps that ran to completion (ok); on failure the failed step itself is not counted. */
  executedSteps: number;
  durationMs: number;
  steps: ReplayStepResult[];
  failure?: ReplayFailure;
}

export interface ReplayEngineOptions {
  trace: AppcraftTrace;
  vars?: Record<string, string>;
  boundApps?: BoundApp[];
  terminator?: ReplayToolClient;
  runCuse?: CuseRunner;
  /** Per-terminator-call timeout. Default 60s (matches TerminatorClient default). */
  toolTimeoutMs?: number;
  /** Timeout for the get_window_tree assert check. Default 30s. */
  assertTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Explicit approval to run steps marked highRisk (PRD §6.8). Without it,
   * a trace containing any high-risk step fails fast with
   * APPROVAL_REQUIRED before executing anything. */
  allowHighRisk?: boolean;
}

const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
const DEFAULT_ASSERT_TIMEOUT_MS = 30_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
}

interface AssertOutcome {
  status: 'passed' | 'failed' | 'unverified';
  warning?: string;
}

/**
 * Verify `assert.windowTitle` via terminator get_window_tree (title substring
 * against the serialized tree). When there is no honest way to verify (no
 * terminator session / no process scope / check itself errors) the assert is
 * reported as 'unverified' with a warning — never silently passed.
 */
async function verifyWindowTitleAssert(
  options: ReplayEngineOptions,
  processName: string | undefined,
  windowTitle: string,
): Promise<AssertOutcome> {
  if (!options.terminator) {
    return { status: 'unverified', warning: `assert windowTitle '${windowTitle}' not verified (no terminator session)` };
  }
  if (!processName) {
    return { status: 'unverified', warning: `assert windowTitle '${windowTitle}' not verified (no bound app process scope)` };
  }
  try {
    const tree = await options.terminator.callTool(
      'get_window_tree',
      { process: processName, include_window_screenshot: false },
      options.assertTimeoutMs ?? DEFAULT_ASSERT_TIMEOUT_MS,
    );
    return JSON.stringify(tree).includes(windowTitle) ? { status: 'passed' } : { status: 'failed' };
  } catch (err) {
    return {
      status: 'unverified',
      warning: `assert windowTitle '${windowTitle}' could not be verified: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Execute a trace step-by-step. Aborts on the first failed step (PRD §6.6:
 * no silent skipping) and returns a structured failure report for the AI
 * self-heal flow when the step declared `fallback: 'ai_vision'`.
 */
export async function replayTrace(options: ReplayEngineOptions): Promise<ReplayReport> {
  const { trace } = options;
  const boundApps = options.boundApps ?? [];
  const processName = resolveProcessName(trace, boundApps);
  const plan = planReplay(trace, options.vars ?? {}, boundApps);
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const steps: ReplayStepResult[] = [];
  const launchWarnings: string[] = [];

  // Bound-app startup (MVP finding): a replayed trace assumes the app is
  // running — when it isn't, every step fails with a cryptic "Element not
  // found". Launch it up-front via terminator open_application (idempotent:
  // activates the window when already running). The launch target prefers the
  // trace's own identity (design C: appInfo.exe) over a boundApp lookup.
  // Pure-vision traces (cuse) skip this. Launch failure is
  // recorded as a warning on every step, NOT fatal — the app may be slow to
  // show its window and the first real step will give the honest verdict.
  const boundApp = resolveBoundAppForTrace(trace, boundApps);
  const launchExe = trace.appInfo?.exe ?? boundApp?.exe;
  if (launchExe && options.terminator && planNeedsTerminator(plan)) {
    try {
      await options.terminator.callTool(
        'open_application',
        {
          app_name: launchExe,
          verify_element_exists: '',
          verify_element_not_exists: '',
          include_tree_after_action: false,
          enable_window_management: true,
          bring_to_front: true,
        },
        options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
      );
    } catch (err) {
      launchWarnings.push(
        `bound app launch failed (${launchExe}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }


  const failWith = (planned: PlannedStep, reason: string): ReplayReport => ({
    status: 'failed',
    app: trace.app,
    stepCount: trace.steps.length,
    executedSteps: steps.filter((s) => s.status === 'ok').length,
    durationMs: now() - startedAt,
    steps,
    failure: {
      stepIndex: planned.stepIndex,
      action: planned.action,
      reason,
      locator: planned.locator,
      fallback: planned.fallback,
      requiresAiHeal: planned.fallback === 'ai_vision',
    },
  });

  for (const planned of plan) {
    const stepStart = now();
    const warnings: string[] = [...launchWarnings];
    const call = planned.call;

    // High-risk approval gate (PRD §6.8): a marked step must never execute
    // without explicit approval. Fail fast BEFORE the step runs; the report
    // carries requiresApproval so the caller can ask a human and retry with
    // allowHighRisk (zhishi appcraft replay --yes-high-risk).
    if (planned.highRisk && !options.allowHighRisk) {
      const reason =
        `step is marked highRisk (irreversible/outbound action) — ` +
        `approve explicitly to run (allowHighRisk / --yes-high-risk)`;
      steps.push({
        stepIndex: planned.stepIndex,
        action: planned.action,
        channel: planned.channel,
        actualChannel: 'none',
        status: 'failed',
        durationMs: 0,
        error: reason,
        warnings,
      });
      return {
        status: 'failed',
        app: trace.app,
        stepCount: trace.steps.length,
        executedSteps: steps.filter((s) => s.status === 'ok').length,
        durationMs: now() - startedAt,
        steps,
        failure: {
          stepIndex: planned.stepIndex,
          action: planned.action,
          reason,
          locator: planned.locator,
          fallback: planned.fallback,
          requiresAiHeal: false,
          requiresApproval: true,
        },
      };
    }
    const toolName =
      call.kind === 'terminator' ? call.tool : call.kind === 'cuse' ? `cuse ${call.args[0]}` : undefined;

    const failStep = (reason: string, assert?: ReplayStepResult['assert']): ReplayReport => {
      steps.push({
        stepIndex: planned.stepIndex,
        action: planned.action,
        channel: planned.channel,
        actualChannel: call.kind === 'unsupported' ? 'none' : call.kind,
        tool: toolName,
        status: 'failed',
        durationMs: now() - stepStart,
        error: reason,
        assert,
        warnings,
      });
      return failWith(planned, reason);
    };

    if (call.kind === 'unsupported') return failStep(call.reason);
    if (call.kind === 'terminator' && !options.terminator) {
      return failStep('terminator client not available (binary not bundled on this platform?)');
    }
    if (call.kind === 'cuse' && !options.runCuse) {
      return failStep('cuse runner not available (binary not bundled on this platform?)');
    }

    // Every terminator step needs a fresh UI tree so element lookup works
    // (builds the index cache for index-mode clicks and confirms the process
    // is visible). Window management stays OFF here too — it is the path that
    // fails with 'Could not find Win32 window' on Win11 apps.
    if (call.kind === 'terminator' && options.terminator && call.args.process) {
      try {
        await (options.terminator as ReplayToolClient).callTool(
          'get_window_tree',
          {
            process: call.args.process,
            include_window_screenshot: false,
            include_tree_after_action: false,
            enable_window_management: false,
          },
          options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
        );
      } catch {
        // Non-fatal — the tool call may still succeed if the window is already
        // frontmost and the terminator has a cached tree.
      }
    }

    // Execute the planned call.
    try {
      if (call.kind === 'terminator') {
        // options.terminator presence checked above
        await (options.terminator as ReplayToolClient).callTool(
          call.tool,
          call.args,
          options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
        );
      } else if (call.kind === 'cuse') {
        const run = await (options.runCuse as CuseRunner)(call.args);
        if (run.timedOut) throw new Error(`cuse ${call.args[0]} timed out`);
        if (run.spawnError) throw new Error(`cuse ${call.args[0]} spawn failed: ${run.spawnError}`);
        if (run.code !== 0) {
          throw new Error(`cuse ${call.args[0]} exited ${run.code}: ${firstLine(run.stdout || run.stderr) || 'no output'}`);
        }
      } else {
        await sleep(call.ms);
      }
    } catch (err) {
      return failStep(err instanceof Error ? err.message : String(err));
    }

    // Post-step assert (contract §4: checkpoint verification).
    let assertStatus: ReplayStepResult['assert'];
    if (planned.assert?.windowTitle) {
      const outcome = await verifyWindowTitleAssert(options, processName, planned.assert.windowTitle);
      assertStatus = outcome.status;
      if (outcome.warning) warnings.push(outcome.warning);
      if (outcome.status === 'failed') {
        return failStep(`assert failed: window title '${planned.assert.windowTitle}' not found`, 'failed');
      }
    }

    steps.push({
      stepIndex: planned.stepIndex,
      action: planned.action,
      channel: planned.channel,
      actualChannel: call.kind,
      tool: toolName,
      status: 'ok',
      durationMs: now() - stepStart,
      assert: assertStatus,
      warnings,
    });
  }

  return {
    status: 'completed',
    app: trace.app,
    stepCount: trace.steps.length,
    executedSteps: steps.length,
    durationMs: now() - startedAt,
    steps,
  };
}
