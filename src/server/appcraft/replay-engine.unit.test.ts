// Unit tests for the AppCraft replay engine (PRD 0.2.36 §6.6).
//
// The engine is tested against a fake terminator client + fake cuse runner —
// no real binaries, no I/O — keeping it in the fast `unit` vitest pool.
import { describe, expect, it } from 'vitest';

import type { AppcraftTrace, AppcraftTraceStep } from '../../shared/appcraft-trace';
import type { BoundApp } from '../../shared/config-types';
import {
  TERMINATOR_ACTION_DEFAULTS,
  buildTerminatorSelector,
  deriveProcessName,
  planNeedsCuse,
  planNeedsTerminator,
  planReplay,
  replayTrace,
  substituteVarsInStep,
  type ReplayToolClient,
  type CuseRunOutcome,
} from './replay-engine';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const kingdee: BoundApp = {
  id: 'kingdee',
  name: '金蝶财务',
  exe: 'C:\\Kingdee\\KIS.exe',
  windowTitle: '金蝶KIS*',
  enabled: true,
};

function makeTrace(steps: AppcraftTraceStep[], app = 'kingdee'): AppcraftTrace {
  return { version: 1, app, recordedAt: '2026-07-19T00:00:00Z', steps };
}

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

function fakeTerminator(handler?: (call: ToolCall) => unknown): ReplayToolClient & { calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  return {
    calls,
    async callTool(name, args) {
      const call = { name, args };
      calls.push(call);
      const result = handler?.(call);
      if (result instanceof Error) throw result;
      return result ?? { content: [], isError: false };
    },
  };
}

function fakeCuse(outcome?: Partial<CuseRunOutcome>): ((args: string[]) => Promise<CuseRunOutcome>) & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = async (args: string[]): Promise<CuseRunOutcome> => {
    calls.push(args);
    return { code: 0, stdout: '', stderr: '', ...outcome };
  };
  fn.calls = calls;
  return fn;
}

const instantSleep = async (): Promise<void> => undefined;

// ---------------------------------------------------------------------------
// Selector construction
// ---------------------------------------------------------------------------

describe('buildTerminatorSelector', () => {
  it('prefers automationId as nativeid selector', () => {
    expect(
      buildTerminatorSelector({ automationId: 'btnExport', controlType: 'Button', name: '导出' }),
    ).toBe('nativeid:btnExport');
  });

  it('combines controlType + name with &&', () => {
    expect(buildTerminatorSelector({ controlType: 'Button', name: '保存' })).toBe('role:Button && name:保存');
  });

  it('falls back to name-only / role-only', () => {
    expect(buildTerminatorSelector({ name: '确定' })).toBe('name:确定');
    expect(buildTerminatorSelector({ controlType: 'Edit' })).toBe('role:Edit');
  });

  it('returns null for empty or missing locator', () => {
    expect(buildTerminatorSelector({})).toBeNull();
    expect(buildTerminatorSelector(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Process name derivation
// ---------------------------------------------------------------------------

describe('deriveProcessName', () => {
  it('strips directory and .exe suffix', () => {
    expect(deriveProcessName('C:\\Kingdee\\KIS.exe')).toBe('KIS');
    expect(deriveProcessName('C:/WeCom/WXWork.EXE')).toBe('WXWork');
  });

  it('leaves extension-less names untouched', () => {
    expect(deriveProcessName('notepad')).toBe('notepad');
  });
});

// ---------------------------------------------------------------------------
// Variable substitution
// ---------------------------------------------------------------------------

describe('substituteVarsInStep', () => {
  it('replaces {{var}} placeholders in locator and nested params', () => {
    const step: AppcraftTraceStep = {
      action: 'uia_set_value',
      channel: 'uia',
      locator: { controlType: 'Edit', name: '{{月份}}输入框' },
      params: { value: '报表-{{月份}}.xlsx', nested: { list: ['{{金额}}'] } },
      assert: { windowTitle: '{{月份}}' }, // assert must NOT be substituted
    };
    const out = substituteVarsInStep(step, { 月份: '2026-06', 金额: '100元' });
    expect(out.locator?.name).toBe('2026-06输入框');
    expect(out.params?.value).toBe('报表-2026-06.xlsx');
    expect((out.params?.nested as { list: string[] }).list[0]).toBe('100元');
    expect(out.assert?.windowTitle).toBe('{{月份}}');
  });

  it('leaves unknown placeholders as-is', () => {
    const step: AppcraftTraceStep = { action: 'type', channel: 'vision', params: { text: '{{未知}}' } };
    expect(substituteVarsInStep(step, {}).params?.text).toBe('{{未知}}');
  });
});

// ---------------------------------------------------------------------------
// Step planning (mapping)
// ---------------------------------------------------------------------------

describe('planReplay', () => {
  it('maps uia_click → terminator invoke_element with selector, process and speed defaults', () => {
    const plan = planReplay(
      makeTrace([
        { action: 'uia_click', channel: 'uia', locator: { controlType: 'Button', name: '导出' } },
      ]),
      {},
      [kingdee],
    );
    expect(plan[0].call).toEqual({
      kind: 'terminator',
      tool: 'invoke_element',
      args: { process: 'KIS', selector: 'role:Button && name:导出', ...TERMINATOR_ACTION_DEFAULTS },
    });
  });

  it('maps uia_set_value → set_value with params.value', () => {
    const plan = planReplay(
      makeTrace([
        {
          action: 'uia_set_value',
          channel: 'uia',
          locator: { automationId: 'edtMonth' },
          params: { value: '{{月份}}' },
        },
      ]),
      { 月份: '2026-06' },
      [kingdee],
    );
    const call = plan[0].call;
    expect(call.kind).toBe('terminator');
    if (call.kind === 'terminator') {
      expect(call.tool).toBe('set_value');
      expect(call.args.selector).toBe('nativeid:edtMonth');
      expect(call.args.value).toBe('2026-06');
    }
  });

  it('accepts params.text as an alias of params.value (recorder type_into_element steps)', () => {
    const plan = planReplay(
      makeTrace([
        {
          action: 'uia_set_value',
          channel: 'uia',
          locator: { automationId: 'memo' },
          params: { text: 'hello' },
        },
      ]),
      {},
      [kingdee],
    );
    const call = plan[0].call;
    expect(call.kind).toBe('terminator');
    if (call.kind === 'terminator') {
      expect(call.tool).toBe('set_value');
      expect(call.args.value).toBe('hello');
    }
  });

  it('maps key → press_key_global (no locator) / press_key (with locator) / cuse key (vision)', () => {
    const plan = planReplay(
      makeTrace([
        { action: 'key', channel: 'command', params: { key: 'ctrl+s' } },
        { action: 'key', channel: 'command', params: { key: '{Enter}' }, locator: { controlType: 'Button', name: '保存' } },
        { action: 'key', channel: 'vision', params: { key: 'enter' } },
      ]),
      {},
      [kingdee],
    );
    // No locator → press_key_global (targets the window itself, no element lookup)
    expect(plan[0].call).toMatchObject({ kind: 'terminator', tool: 'press_key_global', args: { process: 'KIS', key: 'ctrl+s' } });
    // With locator → press_key scoped to the element
    expect(plan[1].call).toMatchObject({ kind: 'terminator', tool: 'press_key', args: { process: 'KIS', key: '{Enter}' } });
    expect(plan[2].call).toEqual({ kind: 'cuse', args: ['key', 'enter'] });
  });

  it('maps vision click/type/scroll → cuse CLI atoms', () => {
    const plan = planReplay(
      makeTrace([
        { action: 'click', channel: 'vision', params: { x: 100, y: 200 } },
        { action: 'type', channel: 'vision', params: { text: 'hello' } },
        { action: 'scroll', channel: 'vision', params: { direction: 'up', amount: 5 } },
      ]),
      {},
      [kingdee],
    );
    expect(plan[0].call).toEqual({ kind: 'cuse', args: ['click', '100', '200'] });
    expect(plan[1].call).toEqual({ kind: 'cuse', args: ['type', 'hello'] });
    expect(plan[2].call).toEqual({ kind: 'cuse', args: ['scroll', 'up', '5'] });
  });

  it('maps wait_window → wait_for_element when a locator exists, else delay', () => {
    const plan = planReplay(
      makeTrace([
        { action: 'wait_window', channel: 'uia', locator: { controlType: 'Window', name: '导出完成' }, params: { timeoutMs: 5000 } },
        { action: 'wait_window', channel: 'vision', params: { ms: 800 } },
      ]),
      {},
      [kingdee],
    );
    expect(plan[0].call).toMatchObject({
      kind: 'terminator',
      tool: 'wait_for_element',
      args: { process: 'KIS', selector: 'role:Window && name:导出完成', timeout_ms: 5000 },
    });
    expect(plan[1].call).toEqual({ kind: 'delay', ms: 800 });
  });

  it('marks unknown actions and missing process scope as unsupported', () => {
    const plan = planReplay(
      makeTrace([
        { action: 'teleport', channel: 'uia' },
        { action: 'uia_click', channel: 'uia', locator: { name: 'x' } },
      ]),
      {},
      [], // no bound apps → no process scope
    );
    expect(plan[0].call.kind).toBe('unsupported');
    expect(plan[1].call.kind).toBe('unsupported');
  });

  it('reports terminator/cuse requirements per plan', () => {
    const visionOnly = planReplay(
      makeTrace([{ action: 'click', channel: 'vision', params: { x: 1, y: 2 } }]),
      {},
      [kingdee],
    );
    expect(planNeedsTerminator(visionOnly)).toBe(false);
    expect(planNeedsCuse(visionOnly)).toBe(true);

    const uiaPlan = planReplay(
      makeTrace([{ action: 'uia_click', channel: 'uia', locator: { name: 'x' } }]),
      {},
      [kingdee],
    );
    expect(planNeedsTerminator(uiaPlan)).toBe(true);
    expect(planNeedsCuse(uiaPlan)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

describe('replayTrace', () => {
  it('executes a mixed trace end-to-end and reports per-step results', async () => {
    const terminator = fakeTerminator();
    const cuse = fakeCuse();
    const report = await replayTrace({
      trace: makeTrace([
        { action: 'uia_click', channel: 'uia', locator: { name: '导出' } },
        { action: 'click', channel: 'vision', params: { x: 10, y: 20 } },
        { action: 'wait_window', channel: 'vision', params: { ms: 500 } },
      ]),
      boundApps: [kingdee],
      terminator,
      runCuse: cuse,
      sleep: instantSleep,
    });

    expect(report.status).toBe('completed');
    expect(report.executedSteps).toBe(3);
    expect(report.steps.map((s) => s.actualChannel)).toEqual(['terminator', 'cuse', 'delay']);
    expect(report.steps[0].tool).toBe('invoke_element');
    expect(report.steps[1].tool).toBe('cuse click');
    // open_application (bound-app startup) + prefetch get_window_tree + invoke_element
    expect(terminator.calls).toHaveLength(3);
    expect(terminator.calls[0].name).toBe('open_application');
    expect(terminator.calls[1].name).toBe('get_window_tree');
    expect(terminator.calls[2].name).toBe('invoke_element');
    expect(cuse.calls).toEqual([['click', '10', '20']]);
    expect(report.steps.every((s) => typeof s.durationMs === 'number')).toBe(true);
  });

  it('runs a pure-vision trace without any terminator client', async () => {
    const cuse = fakeCuse();
    const report = await replayTrace({
      trace: makeTrace([
        { action: 'click', channel: 'vision', params: { x: 1, y: 2 }, assert: { windowTitle: '企业微信' } },
      ]),
      boundApps: [kingdee],
      runCuse: cuse,
      sleep: instantSleep,
    });
    expect(report.status).toBe('completed');
    // assert honestly reported as unverified — no terminator session to check with
    expect(report.steps[0].assert).toBe('unverified');
    expect(report.steps[0].warnings[0]).toContain('not verified');
  });

  it('aborts on step failure and flags requiresAiHeal for fallback ai_vision', async () => {
    const terminator = fakeTerminator(() => new Error('element not found'));
    const report = await replayTrace({
      trace: makeTrace([
        { action: 'click', channel: 'vision', params: { x: 1, y: 2 } },
        {
          action: 'uia_click',
          channel: 'uia',
          locator: { controlType: 'Button', name: '保存' },
          fallback: 'ai_vision',
        },
        { action: 'click', channel: 'vision', params: { x: 3, y: 4 } },
      ]),
      boundApps: [kingdee],
      terminator,
      runCuse: fakeCuse(),
      sleep: instantSleep,
    });

    expect(report.status).toBe('failed');
    expect(report.executedSteps).toBe(1); // step 0 ok, step 1 failed, step 2 never ran
    expect(report.failure).toMatchObject({
      stepIndex: 1,
      action: 'uia_click',
      reason: 'element not found',
      locator: { controlType: 'Button', name: '保存' },
      fallback: 'ai_vision',
      requiresAiHeal: true,
    });
    expect(report.steps).toHaveLength(2);
  });

  it('aborts without requiresAiHeal when the step has no fallback', async () => {
    const terminator = fakeTerminator(() => new Error('boom'));
    const report = await replayTrace({
      trace: makeTrace([{ action: 'uia_click', channel: 'uia', locator: { name: 'x' } }]),
      boundApps: [kingdee],
      terminator,
      sleep: instantSleep,
    });
    expect(report.status).toBe('failed');
    expect(report.failure?.requiresAiHeal).toBe(false);
  });

  it('fails the step when a cuse atom exits non-zero', async () => {
    const report = await replayTrace({
      trace: makeTrace([{ action: 'click', channel: 'vision', params: { x: 1, y: 2 } }]),
      boundApps: [kingdee],
      runCuse: fakeCuse({ code: 1, stderr: 'no display' }),
      sleep: instantSleep,
    });
    expect(report.status).toBe('failed');
    expect(report.failure?.reason).toContain('exited 1');
    expect(report.failure?.reason).toContain('no display');
  });

  it('aborts on unsupported action with a clear reason', async () => {
    const report = await replayTrace({
      trace: makeTrace([{ action: 'teleport', channel: 'uia' }]),
      boundApps: [kingdee],
      terminator: fakeTerminator(),
      sleep: instantSleep,
    });
    expect(report.status).toBe('failed');
    expect(report.failure?.reason).toContain("unsupported action 'teleport'");
  });

  it('verifies assert.windowTitle via get_window_tree and aborts on mismatch', async () => {
    const terminator = fakeTerminator((call) =>
      call.name === 'get_window_tree'
        ? { content: [{ type: 'text', text: 'window: 金蝶KIS 主界面' }], isError: false }
        : undefined,
    );
    const ok = await replayTrace({
      trace: makeTrace([
        { action: 'uia_click', channel: 'uia', locator: { name: '导出' }, assert: { windowTitle: '金蝶KIS' } },
      ]),
      boundApps: [kingdee],
      terminator,
      sleep: instantSleep,
    });
    expect(ok.status).toBe('completed');
    expect(ok.steps[0].assert).toBe('passed');

    const bad = await replayTrace({
      trace: makeTrace([
        { action: 'uia_click', channel: 'uia', locator: { name: '导出' }, assert: { windowTitle: '不存在的窗口' } },
      ]),
      boundApps: [kingdee],
      terminator,
      sleep: instantSleep,
    });
    expect(bad.status).toBe('failed');
    expect(bad.failure?.reason).toContain('assert failed');
    expect(bad.steps[0].assert).toBe('failed');
  });
});


// ---------------------------------------------------------------------------
// High-risk approval gate (PRD §6.8)
// ---------------------------------------------------------------------------

describe('high-risk approval gate', () => {
  const highRiskStep = {
    action: 'uia_click',
    channel: 'uia' as const,
    locator: { controlType: 'Button', name: '发送' },
    highRisk: true,
  };

  it('blocks a high-risk step without allowHighRisk (requiresApproval, nothing executed)', async () => {
    const terminator = fakeTerminator();
    const report = await replayTrace({
      trace: makeTrace([
        { action: 'uia_click', channel: 'uia', locator: { controlType: 'MenuItem', name: '文件' } },
        highRiskStep,
      ]),
      boundApps: [kingdee],
      terminator,
      sleep: instantSleep,
    });

    expect(report.status).toBe('failed');
    expect(report.failure?.requiresApproval).toBe(true);
    expect(report.failure?.requiresAiHeal).toBe(false);
    expect(report.failure?.stepIndex).toBe(1);
    // The high-risk step itself must NOT have executed; step 0 (normal) ran
    // its own invoke_element, so the count is exactly 1, never 2.
    expect(report.executedSteps).toBe(1);
    const invokes = terminator.calls.filter((c) => c.name === 'invoke_element');
    expect(invokes).toHaveLength(1);
  });

  it('executes the high-risk step when allowHighRisk is set', async () => {
    const terminator = fakeTerminator();
    const report = await replayTrace({
      trace: makeTrace([highRiskStep]),
      boundApps: [kingdee],
      terminator,
      sleep: instantSleep,
      allowHighRisk: true,
    });

    expect(report.status).toBe('completed');
    expect(report.executedSteps).toBe(1);
    expect(terminator.calls.map((c) => c.name)).toContain('invoke_element');
  });
});


// ---------------------------------------------------------------------------
// Bound-app startup (MVP finding: replay must launch the app when it isn't running)
// ---------------------------------------------------------------------------

describe('bound-app startup', () => {
  it('launches the bound app before executing terminator steps (idempotent open_application)', async () => {
    const terminator = fakeTerminator();
    const report = await replayTrace({
      trace: makeTrace([
        { action: 'uia_click', channel: 'uia', locator: { controlType: 'MenuItem', name: '文件' } },
      ]),
      boundApps: [kingdee],
      terminator,
      sleep: instantSleep,
    });

    expect(report.status).toBe('completed');
    expect(terminator.calls[0].name).toBe('open_application');
    expect(terminator.calls[0].args.app_name).toBe(kingdee.exe);
  });

  it('skips launch for pure-vision traces', async () => {
    const terminator = fakeTerminator();
    const cuse = fakeCuse();
    await replayTrace({
      trace: makeTrace([{ action: 'click', channel: 'vision', params: { x: 1, y: 2 } }]),
      boundApps: [kingdee],
      terminator,
      runCuse: cuse,
      sleep: instantSleep,
    });
    expect(terminator.calls.map((c) => c.name)).not.toContain('open_application');
  });

  it('launch failure is a warning, not fatal', async () => {
    const terminator = fakeTerminator((call) =>
      call.name === 'open_application' ? new Error('launch failed') : undefined,
    );
    const report = await replayTrace({
      trace: makeTrace([
        { action: 'uia_click', channel: 'uia', locator: { controlType: 'MenuItem', name: '文件' } },
      ]),
      boundApps: [kingdee],
      terminator,
      sleep: instantSleep,
    });
    expect(report.steps[0].warnings?.some((w) => w.includes('launch failed'))).toBe(true);
  });
});
