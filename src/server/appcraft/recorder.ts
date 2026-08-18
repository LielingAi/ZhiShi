/**
 * AppCraft recorder (PRD 0.2.36 §6.4, contract
 * specs/tech_docs/appcraft_engine_contract.md §4): host-side recording of the
 * agent's terminator/cuse MCP tool calls into a trace.json.
 *
 * Recording is the inverse of replay (replay-engine.ts): replay turns a trace
 * locator into a terminator selector (`buildTerminatorSelector`), recording
 * turns the selector string the agent used back into a trace locator
 * (`parseSelector`). The two mappings are deliberately kept in the two
 * modules that own each direction.
 *
 * Capture point: agent-session.ts hooks the SDK assistant message stream
 * (NOT canUseTool — that callback is skipped under bypassPermissions /
 * fullAgency) and calls `appendRecordedStep` per tool_use block. The hook is
 * a Map lookup + pure function, so a non-recording session pays ~nothing.
 *
 * State is a module-level Map keyed by sessionId (Session : Sidecar = 1:1,
 * so one sidecar process holds at most one active recording per session).
 * Everything else is pure/injectable so the module runs in the fast `unit`
 * vitest pool.
 */
import { mkdirSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

import type { AppcraftAppInfo, AppcraftLocator, AppcraftTrace, AppcraftTraceStep } from '../../shared/appcraft-trace';
import { classifyStepRisk } from '../../shared/appcraft-trace';
import type { BoundApp } from '../../shared/config-types';
import { getEnabledBoundAppsForWorkspace } from '../utils/bound-apps';
import { deriveProcessName } from './replay-engine';

// ---------------------------------------------------------------------------
// Recording state
// ---------------------------------------------------------------------------

export interface RecordingState {
  recordingId: string;
  appId: string;
  workspacePath: string;
  /** Process scope for capture_screenshot + trace.appInfo.process. Empty until
   * the first tool call reveals it (zero-config recording: no boundApp needed). */
  processName: string;
  /** True once a tool call's `process` argument has set processName (so later
   * calls don't re-capture, but the first call always overrides the boundApp
   * default with what the agent is actually operating). */
  processCapturedFromCall: boolean;
  /** BoundApp fields when the recording targeted a bound app (optional). */
  boundExe?: string;
  boundWindowTitle?: string;
  /** Absolute dir for keyframe files (`<workspace>/.appcraft/<id>/frames`). */
  framesDir: string;
  /** ISO 8601 timestamp of record start (becomes trace.recordedAt). */
  startedAt: string;
  steps: AppcraftTraceStep[];
  /** tool_use_id → index into `steps`, for failure filtering: a tool call
   * whose tool_result comes back is_error is dropped from the trace (a failed
   * selector attempt is replay noise, not an action the user wants repeated). */
  stepIndexByToolUseId: Map<string, number>;
  /** In-flight keyframe captures; stopRecording awaits them before writing. */
  pendingKeyframes: Promise<void>[];
  /** Injectable capture impl copied from deps at record start (undefined = no keyframes). */
  captureKeyframe?: (processName: string, filePath: string) => Promise<boolean>;
}

const activeRecordings = new Map<string, RecordingState>();

/** Injectable collaborators — production uses the defaults, tests inject fakes. */
export interface RecorderDeps {
  /** Injectable capture impl — production passes defaultCaptureKeyframe from
   * the record-start handler; tests stay hermetic by leaving it undefined. */
  captureKeyframe?: (processName: string, filePath: string) => Promise<boolean>;
  /** Defaults to getEnabledBoundAppsForWorkspace (reads projects.json). */
  getBoundApps?: (workspacePath: string) => BoundApp[];
  /** Clock, for deterministic recordingIds in tests. */
  now?: () => Date;
  /** Defaults to an atomic tmp+rename write. */
  writeTraceFile?: (tracePath: string, json: string) => void;
}

/** Test-only: drop all in-flight recording state (unit-pool isolation). */
export function resetRecordingsForTest(): void {
  activeRecordings.clear();
}

// ---------------------------------------------------------------------------
// Selector → locator (inverse of replay's buildTerminatorSelector)
// ---------------------------------------------------------------------------

/**
 * Parse a terminator selector string back into a trace locator:
 *   `nativeid:X`          → { automationId: X }            (most stable — wins)
 *   `role:R && name:N`    → { controlType: R, name: N }
 *   `text:T`              → { name: T }
 *
 * Known limitation: terminator selectors support full boolean/combinator
 * syntax (`||`, `!`, `>>` chain, `..` parent) which a flat
 * {controlType,name,automationId} locator cannot express. We keep only the
 * first `&&` group and drop negated clauses and anything after a `||`/`>>`/`..`
 * boundary — the recorded locator is therefore a *best-effort* anchor, and a
 * step recorded from a complex selector may replay against a wider element
 * set than the agent originally targeted. `process:` clauses are dropped too
 * (process scope comes from trace.app at replay time, not from the locator).
 */
export function parseSelector(selector: string | undefined): AppcraftLocator | undefined {
  if (!selector || typeof selector !== 'string') return undefined;
  const firstGroup = selector.split('||')[0].split('>>')[0].split('..')[0];
  const locator: AppcraftLocator = {};
  // Terminator also uses a SINGLE pipe as a condition separator
  // (e.g. `MenuItem|name:文件`, `role:Window|name:Untitled`) — normalize to
  // `&&` before clause splitting, or the whole `A|B` string lands in one field.
  for (const rawClause of firstGroup.replace(/\|/g, '&&').split('&&')) {
    const clause = rawClause.trim();
    if (!clause || clause.startsWith('!')) continue;
    const sep = clause.indexOf(':');
    if (sep <= 0) {
      // Bare clause without a `key:` prefix (e.g. `MenuItem|name:文件` — the
      // agent legitimately writes role shorthand) → treat as the control type.
      locator.controlType = clause;
      continue;
    }
    const key = clause.slice(0, sep).trim().toLowerCase();
    const value = clause.slice(sep + 1).trim();
    if (!value) continue;
    if (key === 'nativeid') locator.automationId = value;
    else if (key === 'role') locator.controlType = value;
    else if (key === 'name') locator.name = value;
    else if (key === 'text') locator.name = value;
    // other keys (process:, window:, …) are not locator fields — dropped
  }
  // Mirror buildTerminatorSelector's priority: an automationId renders as a
  // bare `nativeid:` selector, so role/name alongside it would be dead weight.
  if (locator.automationId) return { automationId: locator.automationId };
  return locator.controlType || locator.name ? locator : undefined;
}

// ---------------------------------------------------------------------------
// Tool call → trace step
// ---------------------------------------------------------------------------

/**
 * Per-call context for future per-app mapping tweaks (e.g. app-specific tool
 * quirks). Unused by today's mappings — kept so the capture hook's call shape
 * is stable when mappings grow.
 */
export interface RecorderStepContext {
  appId?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function selectorOf(input: Record<string, unknown>): string | undefined {
  return typeof input.selector === 'string' ? input.selector : undefined;
}

function uiaElementStep(
  action: 'uia_click' | 'uia_set_value',
  input: Record<string, unknown>,
  params: Record<string, unknown>,
): AppcraftTraceStep {
  const step: AppcraftTraceStep = { action, channel: 'uia', params };
  const locator = parseSelector(selectorOf(input));
  if (locator) step.locator = locator;
  return step;
}

/**
 * Map one MCP tool call to a trace step; null = not recorded (perception
 * tools, lifecycle tools, anything not from the two AppCraft engines).
 *
 * Mappings (contract §2/§3, channel semantics from §3):
 *   terminator invoke_element / click_element → uia_click     (uia)
 *   terminator set_value                      → uia_set_value (uia, params.value)
 *   terminator type_into_element              → uia_set_value (uia, params.text
 *     from text_to_type — semantics are "type this text"; the replay engine
 *     accepts params.text as an alias of params.value for this reason)
 *   terminator press_key                      → key           (command)
 *   terminator open_application               → null (launch is covered by the
 *     bound-app startup semantics, not an interactive step)
 *   cuse click / type / key / scroll          → vision steps (params pass through)
 *   cuse screenshot (and anything else)       → null (perception, not an action)
 */
export function mapToolCallToStep(
  toolName: string,
  input: Record<string, unknown> | undefined,
  _ctx?: RecorderStepContext,
): AppcraftTraceStep | null {
  const args = asRecord(input);
  switch (toolName) {
    case 'mcp__terminator__invoke_element':
    case 'mcp__terminator__click_element': {
      // Index-mode clicks (`index: 8` from a UI-tree dump, no selector) have no
      // semantic locator — record the index so the trace is honest, knowing the
      // replay engine cannot re-resolve it semantically today (that step will
      // surface as unsupported and route to AI heal, which is the right outcome
      // for a positionally-anchored action anyway).
      const params: Record<string, unknown> = {};
      if (typeof args.index === 'number') params.index = args.index;
      return uiaElementStep('uia_click', args, params);
    }

    case 'mcp__terminator__set_value':
      return uiaElementStep('uia_set_value', args, { value: args.value });

    case 'mcp__terminator__type_into_element':
      return uiaElementStep('uia_set_value', args, { text: args.text_to_type });

    case 'mcp__terminator__press_key':
      return { action: 'key', channel: 'command', params: { key: args.key } };

    case 'mcp__cuse__click':
      return { action: 'click', channel: 'vision', params: { x: args.x, y: args.y } };

    case 'mcp__cuse__type':
      return { action: 'type', channel: 'vision', params: { text: args.text } };

    case 'mcp__cuse__key':
      return { action: 'key', channel: 'vision', params: { key: args.key } };

    case 'mcp__cuse__scroll':
      return {
        action: 'scroll',
        channel: 'vision',
        params: { direction: args.direction ?? 'down', amount: args.amount },
      };

    default:
      return null;
  }
}

/**
 * "动作类工具" 谓词（P2b-1 回溯式沉淀入口，宪章 §6.1/§6.2）：true iff 该工具
 * 是 AppCraft 两引擎（terminator/cuse）的动作类调用——即 mapToolCallToStep 能
 * 把它落成 trace step。感知类（get_window_tree / screenshot）与生命周期类
 * （open_application）不算动作，与录制口径严格一致（单一事实源 = 映射表本身，
 * 新增动作工具时这里自动跟随）。
 */
export function isAppcraftActionTool(toolName: string): boolean {
  return mapToolCallToStep(toolName, undefined) !== null;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** `<yyyyMMdd-HHmmss>` in LOCAL time — recordingIds are user-facing dir names. */
function formatRecordingTimestamp(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/** Atomic write: tmp file in the same directory + rename (single-writer, no lock needed). */
function writeTraceFileAtomic(tracePath: string, json: string): void {
  mkdirSync(dirname(tracePath), { recursive: true });
  const tmpPath = `${tracePath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, json, 'utf-8');
  renameSync(tmpPath, tracePath);
}

export type StartRecordingResult =
  | { ok: true; recordingId: string }
  | { ok: false; error: string };

/**
 * Start recording a session against a bound app. Fails when the session is
 * already recording (one active recording per session) or when `appId` is not
 * an enabled bound app of the workspace.
 */
export function startRecording(
  sessionId: string,
  workspacePath: string,
  appId: string,
  deps: RecorderDeps = {},
): StartRecordingResult {
  const existing = activeRecordings.get(sessionId);
  if (existing) {
    return {
      ok: false,
      error: `This session is already recording (${existing.recordingId}) — stop it before starting a new one.`,
    };
  }
  const getBoundApps = deps.getBoundApps ?? getEnabledBoundAppsForWorkspace;
  const app = appId ? getBoundApps(workspacePath).find((a) => a.id === appId) : undefined;
  if (appId && !app) {
    return {
      ok: false,
      error: `Bound app '${appId}' not found or not enabled in workspace '${workspacePath}'.`,
    };
  }
  const now = (deps.now ?? (() => new Date()))();
  const recordingId = `${appId || 'auto'}-${formatRecordingTimestamp(now)}`;
  activeRecordings.set(sessionId, {
    recordingId,
    appId,
    workspacePath,
    processName: app ? deriveProcessName(app.exe) : '',
    processCapturedFromCall: false,
    boundExe: app?.exe,
    boundWindowTitle: app?.windowTitle,
    framesDir: join(workspacePath, '.appcraft', recordingId, 'frames'),
    startedAt: now.toISOString(),
    steps: [],
    stepIndexByToolUseId: new Map(),
    pendingKeyframes: [],
    captureKeyframe: deps.captureKeyframe,
  });
  return { ok: true, recordingId };
}

/**
 * Capture hook called from the assistant message stream. Map lookup +
 * pure mapping only — safe to call for every tool_use block of every
 * session. Returns true when a step was appended.
 */
export function appendRecordedStep(
  sessionId: string,
  toolName: string,
  input: Record<string, unknown> | undefined,
  toolUseId?: string,
): boolean {
  const rec = activeRecordings.get(sessionId);
  if (!rec) return false;
  // Identity capture: the first tool call carrying a `process` argument is the
  // ground truth of what the agent is ACTUALLY operating — it overrides the
  // boundApp-derived default, so selecting bound app A but operating app B
  // records B's identity, not A's.
  if (!rec.processCapturedFromCall && typeof input?.process === 'string' && input.process.length > 0) {
    rec.processName = input.process;
    rec.processCapturedFromCall = true;
  }
  const step = mapToolCallToStep(toolName, input, { appId: rec.appId });
  if (!step) return false;
  // High-risk marking at capture time (PRD §6.8): steps with irreversible/
  // outbound semantics get flagged so replay can demand explicit approval.
  if (classifyStepRisk(step) === 'high') step.highRisk = true;
  rec.steps.push(step);
  if (toolUseId) {
    rec.stepIndexByToolUseId.set(toolUseId, rec.steps.length - 1);
  }
  // Keyframe capture (§6.4 frames/): fire-and-forget after-action screenshot
  // of the bound app's window. The step gets its keyframe path optimistically;
  // a failed capture clears it again (honest trace over broken links). The
  // file name is append-order based, so a later is_error drop only leaves an
  // orphan file — never a step pointing at the wrong frame.
  if (rec.captureKeyframe) {
    const fileName = `step${rec.steps.length}.jpg`;
    step.keyframe = `frames/${fileName}`;
    const capture = rec
      .captureKeyframe(rec.processName, join(rec.framesDir, fileName))
      .then((ok) => {
        if (!ok) delete step.keyframe;
      })
      .catch(() => {
        delete step.keyframe;
      });
    rec.pendingKeyframes.push(capture);
  }
  return true;
}

/**
 * Drop a previously-recorded step whose tool_result came back is_error.
 * Called from the agent-session tool_result hook: failed selector attempts
 * (agent retrying a locator that didn't match) must not end up in the replay
 * trace. Returns true when a step was actually dropped.
 */
export function dropRecordedStep(sessionId: string, toolUseId: string): boolean {
  const rec = activeRecordings.get(sessionId);
  if (!rec) return false;
  const idx = rec.stepIndexByToolUseId.get(toolUseId);
  if (idx === undefined) return false;
  rec.steps.splice(idx, 1);
  rec.stepIndexByToolUseId.delete(toolUseId);
  // Re-index: every entry after idx shifted down by one.
  for (const [id, i] of rec.stepIndexByToolUseId) {
    if (i > idx) rec.stepIndexByToolUseId.set(id, i - 1);
  }
  return true;
}

export type StopRecordingResult =
  | { ok: true; recordingId: string; tracePath: string; stepCount: number; trace: AppcraftTrace }
  | { ok: false; error: string };

/**
 * Stop the session's recording: build the trace and write it to
 * `<workspace>/.appcraft/<recordingId>/trace.json` (atomic tmp+rename).
 * Stop is terminal — the session entry is cleared in every outcome. A
 * recording with zero steps is an error and is NOT written to disk.
 */
export async function stopRecording(sessionId: string, deps: RecorderDeps = {}): Promise<StopRecordingResult> {
  const rec = activeRecordings.get(sessionId);
  if (!rec) return { ok: false, error: 'No active recording for this session.' };
  activeRecordings.delete(sessionId);
  if (rec.steps.length === 0) {
    return {
      ok: false,
      error:
        'Recording captured no steps — nothing to save.\n' +
        '提示：录制器只捕获 AI 经 terminator/cuse MCP 工具的操作，不记录手动操作。' +
        '开始录制后请在会话里让 AI 完成操作（如"用 terminator 在记事本里输入 X"），再停止。',
    };
  }
  // Drain in-flight keyframe captures so trace.json never references a frame
  // that hasn't landed on disk yet (failures already cleared their keyframe).
  await Promise.allSettled(rec.pendingKeyframes);
  // Self-contained app identity (design C): the trace carries everything the
  // replay needs to resolve the target without consulting boundApps — process
  // for scoping, exe for auto-launch, windowTitle as a secondary matcher.
  const appInfo: AppcraftAppInfo = {
    ...(rec.processName ? { process: rec.processName } : {}),
    ...(rec.boundExe ? { exe: rec.boundExe } : {}),
    ...(rec.boundWindowTitle ? { windowTitle: rec.boundWindowTitle } : {}),
  };
  const trace: AppcraftTrace = {
    version: 1,
    app: rec.appId || rec.processName || 'unknown',
    ...(Object.keys(appInfo).length > 0 ? { appInfo } : {}),
    recordedAt: rec.startedAt,
    steps: rec.steps,
  };
  const tracePath = join(rec.workspacePath, '.appcraft', rec.recordingId, 'trace.json');
  const write = deps.writeTraceFile ?? writeTraceFileAtomic;
  write(tracePath, `${JSON.stringify(trace, null, 2)}\n`);
  return { ok: true, recordingId: rec.recordingId, tracePath, stepCount: rec.steps.length, trace };
}

export interface RecordingStatus {
  recording: boolean;
  recordingId?: string;
  appId?: string;
  startedAt?: string;
  stepCount?: number;
}

export function getRecordingStatus(sessionId: string): RecordingStatus {
  const rec = activeRecordings.get(sessionId);
  if (!rec) return { recording: false };
  return {
    recording: true,
    recordingId: rec.recordingId,
    appId: rec.appId,
    startedAt: rec.startedAt,
    stepCount: rec.steps.length,
  };
}

// ---------------------------------------------------------------------------
// Default keyframe capture (production): terminator capture_screenshot
// ---------------------------------------------------------------------------

let keyframeClientPromise: Promise<import('./terminator-client').TerminatorClient> | null = null;

/**
 * Production capture impl (wired in by the record-start admin handler):
 * screenshots the bound app's window via terminator capture_screenshot and
 * writes the JPEG to filePath. Returns false on any failure (missing binary,
 * tool error, no image content) — the caller then clears step.keyframe.
 */
export async function defaultCaptureKeyframe(processName: string, filePath: string): Promise<boolean> {
  try {
    const { getBundledTerminatorPath } = await import('../utils/runtime');
    const binPath = getBundledTerminatorPath();
    if (!binPath) return false;
    if (!keyframeClientPromise) {
      const { TerminatorClient } = await import('./terminator-client');
      keyframeClientPromise = TerminatorClient.start({ binaryPath: binPath });
    }
    const client = await keyframeClientPromise;
    const result = await client.callTool(
      'capture_screenshot',
      {
        process: processName,
        selector: '',
        verify_element_exists: '',
        verify_element_not_exists: '',
        include_tree_after_action: false,
        include_window_screenshot: false,
      },
      30_000,
    );
    const content = (result as { content?: unknown[] } | null)?.content;
    const img = Array.isArray(content)
      ? content.find(
          (c): c is { type: string; data: string } =>
            !!c &&
            typeof c === 'object' &&
            (c as { type?: string }).type === 'image' &&
            typeof (c as { data?: unknown }).data === 'string',
        )
      : undefined;
    if (!img) return false;
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, Buffer.from(img.data, 'base64'));
    return true;
  } catch {
    return false;
  }
}
