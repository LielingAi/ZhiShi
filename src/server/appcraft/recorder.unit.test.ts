// Unit tests for the AppCraft recorder (PRD 0.2.36 搂6.4).
//
// All collaborators (bound apps, clock, trace writer) are injected 鈥?no real
// projects.json, no disk 鈥?keeping the module in the fast `unit` vitest pool.
import { join } from 'path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { BoundApp } from '../../shared/config-types';
import {
  appendRecordedStep,
  getRecordingStatus,
  mapToolCallToStep,
  parseSelector,
  resetRecordingsForTest,
  startRecording,
  stopRecording,
  type RecorderDeps,
} from './recorder';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const kingdee: BoundApp = {
  id: 'kingdee',
  name: '閲戣澏璐㈠姟',
  exe: 'C:\\Kingdee\\KIS.exe',
  windowTitle: '閲戣澏KIS*',
  enabled: true,
};

const WORKSPACE = 'E:\\ws\\demo';
const SESSION = 'sess-1';

function makeDeps(overrides: Partial<RecorderDeps> = {}): RecorderDeps & { writes: Array<{ path: string; json: string }> } {
  const writes: Array<{ path: string; json: string }> = [];
  return {
    writes,
    getBoundApps: () => [kingdee],
    now: () => new Date('2026-07-19T10:30:00+08:00'),
    writeTraceFile: (path, json) => {
      writes.push({ path, json });
    },
    ...overrides,
  };
}

// recordingId embeds a LOCAL-time timestamp (yyyyMMdd-HHmmss) 鈥?pin TZ so the
// expected id is deterministic across developer machines and CI.
const ORIGINAL_TZ = process.env.TZ;
beforeAll(() => { process.env.TZ = 'Asia/Shanghai'; });
afterAll(() => { process.env.TZ = ORIGINAL_TZ; });

afterEach(() => {
  resetRecordingsForTest();
});

// ---------------------------------------------------------------------------
// parseSelector 鈥?terminator selector 鈫?trace locator (inverse of
// replay-engine's buildTerminatorSelector)
// ---------------------------------------------------------------------------

describe('parseSelector', () => {
  it('maps nativeid to automationId and drops accompanying role/name', () => {
    expect(parseSelector('nativeid:btnExport')).toEqual({ automationId: 'btnExport' });
    expect(parseSelector('nativeid:btnExport && role:Button')).toEqual({ automationId: 'btnExport' });
  });

  it('maps role && name to controlType + name', () => {
    expect(parseSelector('role:Button && name:淇濆瓨')).toEqual({ controlType: 'Button', name: '淇濆瓨' });
    expect(parseSelector('name:纭畾')).toEqual({ name: '纭畾' });
    expect(parseSelector('role:Edit')).toEqual({ controlType: 'Edit' });
  });

  it('maps text to name', () => {
    expect(parseSelector('text:绮剧‘鏂囨湰')).toEqual({ name: '绮剧‘鏂囨湰' });
  });

  it('drops negated clauses and keeps only the first && group', () => {
    expect(parseSelector('role:Button && !name:鍒犻櫎')).toEqual({ controlType: 'Button' });
    expect(parseSelector('role:Button && name:淇濆瓨 || role:Edit')).toEqual({ controlType: 'Button', name: '淇濆瓨' });
    expect(parseSelector('role:Window >> role:Button')).toEqual({ controlType: 'Window' });
  });

  it('ignores process: clauses and unknown keys', () => {
    expect(parseSelector('process:KIS && role:Button')).toEqual({ controlType: 'Button' });
  });

  it('returns undefined for empty / unusable selectors', () => {
    expect(parseSelector(undefined)).toBeUndefined();
    expect(parseSelector('')).toBeUndefined();
    expect(parseSelector('   ')).toBeUndefined();
    expect(parseSelector('!name:鍒犻櫎')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mapToolCallToStep 鈥?every branch
// ---------------------------------------------------------------------------

describe('mapToolCallToStep', () => {
  it('maps terminator invoke/click to uia_click', () => {
    for (const tool of ['mcp__terminator__invoke_element', 'mcp__terminator__click_element']) {
      expect(mapToolCallToStep(tool, { process: 'KIS', selector: 'nativeid:btnExport' })).toEqual({
        action: 'uia_click',
        channel: 'uia',
        locator: { automationId: 'btnExport' },
        params: {},
      });
    }
  });

  it('maps terminator set_value to uia_set_value with params.value', () => {
    expect(
      mapToolCallToStep('mcp__terminator__set_value', {
        selector: 'role:Edit && name:閲戦',
        value: '3500',
      }),
    ).toEqual({
      action: 'uia_set_value',
      channel: 'uia',
      locator: { controlType: 'Edit', name: '閲戦' },
      params: { value: '3500' },
    });
  });

  it('maps terminator type_into_element to uia_set_value with params.text', () => {
    expect(
      mapToolCallToStep('mcp__terminator__type_into_element', {
        selector: 'nativeid:memo',
        text_to_type: 'hello',
      }),
    ).toEqual({
      action: 'uia_set_value',
      channel: 'uia',
      locator: { automationId: 'memo' },
      params: { text: 'hello' },
    });
  });

  it('maps terminator press_key to key on the command channel', () => {
    expect(mapToolCallToStep('mcp__terminator__press_key', { key: 'ctrl+s' })).toEqual({
      action: 'key',
      channel: 'command',
      params: { key: 'ctrl+s' },
    });
  });

  it('maps cuse vision tools to vision steps', () => {
    expect(mapToolCallToStep('mcp__cuse__click', { x: 100, y: 200 })).toEqual({
      action: 'click',
      channel: 'vision',
      params: { x: 100, y: 200 },
    });
    expect(mapToolCallToStep('mcp__cuse__type', { text: 'abc' })).toEqual({
      action: 'type',
      channel: 'vision',
      params: { text: 'abc' },
    });
    expect(mapToolCallToStep('mcp__cuse__key', { key: 'enter' })).toEqual({
      action: 'key',
      channel: 'vision',
      params: { key: 'enter' },
    });
    expect(mapToolCallToStep('mcp__cuse__scroll', { direction: 'up', amount: 5 })).toEqual({
      action: 'scroll',
      channel: 'vision',
      params: { direction: 'up', amount: 5 },
    });
  });

  it('defaults cuse scroll direction to down', () => {
    expect(mapToolCallToStep('mcp__cuse__scroll', { amount: 3 })).toEqual({
      action: 'scroll',
      channel: 'vision',
      params: { direction: 'down', amount: 3 },
    });
  });

  it('omits the locator when the selector is missing or unusable', () => {
    expect(mapToolCallToStep('mcp__terminator__click_element', {})).toEqual({
      action: 'uia_click',
      channel: 'uia',
      params: {},
    });
  });

  it('ignores lifecycle / perception / unknown tools', () => {
    expect(mapToolCallToStep('mcp__terminator__open_application', { path: 'KIS.exe' })).toBeNull();
    expect(mapToolCallToStep('mcp__terminator__get_window_tree', { process: 'KIS' })).toBeNull();
    expect(mapToolCallToStep('mcp__cuse__screenshot', {})).toBeNull();
    expect(mapToolCallToStep('mcp__other__click', { x: 1 })).toBeNull();
    expect(mapToolCallToStep('Bash', { command: 'ls' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// start/stop lifecycle
// ---------------------------------------------------------------------------

describe('startRecording', () => {
  it('generates a <appId>-<yyyyMMdd-HHmmss> recordingId and reports status', () => {
    const deps = makeDeps();
    const result = startRecording(SESSION, WORKSPACE, 'kingdee', deps);
    expect(result).toEqual({ ok: true, recordingId: 'kingdee-20260719-103000' });
    expect(getRecordingStatus(SESSION)).toEqual({
      recording: true,
      recordingId: 'kingdee-20260719-103000',
      appId: 'kingdee',
      startedAt: '2026-07-19T02:30:00.000Z',
      stepCount: 0,
    });
  });

  it('rejects a second recording on the same session', () => {
    const deps = makeDeps();
    expect(startRecording(SESSION, WORKSPACE, 'kingdee', deps).ok).toBe(true);
    const conflict = startRecording(SESSION, WORKSPACE, 'kingdee', deps);
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error).toContain('already recording');
  });

  it('rejects unknown / disabled bound apps', () => {
    const deps = makeDeps({ getBoundApps: () => [] });
    const result = startRecording(SESSION, WORKSPACE, 'notepad', deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('notepad');
    expect(getRecordingStatus(SESSION).recording).toBe(false);
  });

  it('tracks sessions independently', () => {
    const deps = makeDeps();
    expect(startRecording('s1', WORKSPACE, 'kingdee', deps).ok).toBe(true);
    expect(startRecording('s2', WORKSPACE, 'kingdee', deps).ok).toBe(true);
    expect(getRecordingStatus('s3').recording).toBe(false);
  });
});

describe('appendRecordedStep', () => {
  it('appends mapped steps and counts them in status', () => {
    const deps = makeDeps();
    startRecording(SESSION, WORKSPACE, 'kingdee', deps);
    expect(appendRecordedStep(SESSION, 'mcp__terminator__click_element', { selector: 'nativeid:a' })).toBe(true);
    expect(appendRecordedStep(SESSION, 'mcp__cuse__click', { x: 1, y: 2 })).toBe(true);
    expect(getRecordingStatus(SESSION).stepCount).toBe(2);
  });

  it('is a no-op when not recording or the tool is not mapped', () => {
    const deps = makeDeps();
    expect(appendRecordedStep(SESSION, 'mcp__cuse__click', { x: 1, y: 2 })).toBe(false);
    startRecording(SESSION, WORKSPACE, 'kingdee', deps);
    expect(appendRecordedStep(SESSION, 'mcp__terminator__get_window_tree', {})).toBe(false);
    expect(getRecordingStatus(SESSION).stepCount).toBe(0);
  });
});

describe('stopRecording', () => {
  it('writes <workspace>/.appcraft/<recordingId>/trace.json and clears state', async () => {
    const deps = makeDeps();
    startRecording(SESSION, WORKSPACE, 'kingdee', deps);
    appendRecordedStep(SESSION, 'mcp__terminator__click_element', { selector: 'nativeid:btnExport' });
    appendRecordedStep(SESSION, 'mcp__terminator__set_value', { selector: 'role:Edit && name:金蝶', value: '3500' });

    const result = await stopRecording(SESSION, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recordingId).toBe('kingdee-20260719-103000');
    expect(result.stepCount).toBe(2);
    expect(result.tracePath).toBe(join(WORKSPACE, '.appcraft', 'kingdee-20260719-103000', 'trace.json'));

    expect(deps.writes).toHaveLength(1);
    const written = JSON.parse(deps.writes[0].json);
    expect(written.version).toBe(1);
    expect(written.app).toBe('kingdee');
    expect(written.recordedAt).toBe('2026-07-19T02:30:00.000Z');
    expect(written.steps).toHaveLength(2);
    expect(written.steps[0]).toEqual({
      action: 'uia_click',
      channel: 'uia',
      locator: { automationId: 'btnExport' },
      params: {},
    });

    expect(getRecordingStatus(SESSION).recording).toBe(false);
  });

  it('errors without writing when there are no steps, and still clears state', async () => {
    const deps = makeDeps();
    startRecording(SESSION, WORKSPACE, 'kingdee', deps);
    const result = await stopRecording(SESSION, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('no steps');
    expect(deps.writes).toHaveLength(0);
    expect(getRecordingStatus(SESSION).recording).toBe(false);
  });

  it('errors when the session was never recording', async () => {
    const result = await stopRecording(SESSION, makeDeps());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('No active recording');
  });
});


// ---------------------------------------------------------------------------
// 0.2.36 MVP fixes: single-pipe selectors, index-mode clicks, failure filtering
// ---------------------------------------------------------------------------

describe('parseSelector 鈥?single-pipe separator (MVP fix)', () => {
  it('splits single-pipe condition chains like MenuItem|name:鏂囦欢', () => {
    expect(parseSelector('MenuItem|name:鏂囦欢')).toEqual({
      controlType: 'MenuItem',
      name: '鏂囦欢',
    });
  });

  it('splits role:X|name:Y form', () => {
    expect(parseSelector('role:MenuItem|name:鏂囦欢')).toEqual({
      controlType: 'MenuItem',
      name: '鏂囦欢',
    });
  });

  it('nativeid still wins over role/name', () => {
    expect(parseSelector('nativeid:btnExport|role:Button')).toEqual({
      automationId: 'btnExport',
    });
  });
});

describe('mapToolCallToStep 鈥?index-mode clicks (MVP fix)', () => {
  it('records params.index for index-mode click_element', () => {
    const step = mapToolCallToStep('mcp__terminator__click_element', { index: 8 });
    expect(step).not.toBeNull();
    expect(step!.action).toBe('uia_click');
    expect(step!.params).toEqual({ index: 8 });
    expect(step!.locator).toBeUndefined();
  });

  it('selector-mode click still records the locator and no index', () => {
    const step = mapToolCallToStep('mcp__terminator__invoke_element', {
      selector: 'MenuItem|name:鏂囦欢',
    });
    expect(step!.params).toEqual({});
    expect(step!.locator).toEqual({ controlType: 'MenuItem', name: '鏂囦欢' });
  });
});

describe('dropRecordedStep 鈥?failure filtering (MVP fix)', () => {
  it('drops the failed step and re-indexes the pending map', async () => {
    const { dropRecordedStep } = await import('./recorder');
    const deps = makeDeps();
    startRecording(SESSION, WORKSPACE, 'kingdee', deps);
    appendRecordedStep(SESSION, 'mcp__terminator__invoke_element', { selector: 'name:不存在' }, 'tu-1');
    appendRecordedStep(SESSION, 'mcp__terminator__press_key', { key: 'Escape' }, 'tu-2');
    appendRecordedStep(SESSION, 'mcp__terminator__set_value', { selector: 'role:Document', value: 'x' }, 'tu-3');

    expect(dropRecordedStep(SESSION, 'tu-1')).toBe(true);

    const result = await stopRecording(SESSION, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stepCount).toBe(2);
    expect(result.trace.steps.map(s => s.action)).toEqual(['key', 'uia_set_value']);
  });

  it('drop of unknown id is a no-op', async () => {
    const { dropRecordedStep } = await import('./recorder');
    const deps = makeDeps();
    startRecording(SESSION, WORKSPACE, 'kingdee', deps);
    appendRecordedStep(SESSION, 'mcp__terminator__press_key', { key: 'Escape' }, 'tu-2');
    expect(dropRecordedStep(SESSION, 'tu-999')).toBe(false);
    const result = await stopRecording(SESSION, deps);
    expect(result.ok && result.stepCount).toBe(1);
  });
});


// ---------------------------------------------------------------------------
// Keyframes (§6.4 frames/): capture at append, drain at stop
// ---------------------------------------------------------------------------

describe('keyframes', () => {
  it('assigns frames/step<N>.jpg at append and drains captures at stop', async () => {
    const captured: string[] = [];
    const deps = makeDeps({
      captureKeyframe: async (_proc, filePath) => {
        captured.push(filePath);
        return true;
      },
    });
    startRecording(SESSION, WORKSPACE, 'kingdee', deps);
    appendRecordedStep(SESSION, 'mcp__terminator__invoke_element', { selector: 'role:Button && name:保存' });
    appendRecordedStep(SESSION, 'mcp__terminator__press_key', { key: 'Enter' });

    const result = await stopRecording(SESSION, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(captured).toHaveLength(2);
    expect(captured[0]).toContain(join(WORKSPACE, '.appcraft', 'kingdee-20260719-103000', 'frames', 'step1.jpg'));
    expect(result.trace.steps[0].keyframe).toBe('frames/step1.jpg');
    expect(result.trace.steps[1].keyframe).toBe('frames/step2.jpg');
  });

  it('clears keyframe when the capture fails (honest trace over broken links)', async () => {
    const deps = makeDeps({ captureKeyframe: async () => false });
    startRecording(SESSION, WORKSPACE, 'kingdee', deps);
    appendRecordedStep(SESSION, 'mcp__terminator__press_key', { key: 'Enter' });
    const result = await stopRecording(SESSION, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trace.steps[0].keyframe).toBeUndefined();
  });

  it('no captureKeyframe dep → steps have no keyframe field', async () => {
    const deps = makeDeps();
    startRecording(SESSION, WORKSPACE, 'kingdee', deps);
    appendRecordedStep(SESSION, 'mcp__terminator__press_key', { key: 'Enter' });
    const result = await stopRecording(SESSION, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trace.steps[0].keyframe).toBeUndefined();
  });
});


// ---------------------------------------------------------------------------
// Zero-config identity (design C): appInfo in trace
// ---------------------------------------------------------------------------

describe('appInfo (design C zero-config identity)', () => {
  it('no appId: trace.app falls back to process name, appInfo carries process from first tool call', async () => {
    const deps = makeDeps();
    startRecording(SESSION, WORKSPACE, '', deps);
    appendRecordedStep(SESSION, 'mcp__terminator__invoke_element', {
      process: 'notepad',
      selector: 'MenuItem|name:文件',
    });
    const result = await stopRecording(SESSION, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trace.app).toBe('notepad');
    expect(result.trace.appInfo?.process).toBe('notepad');
    expect(result.trace.appInfo?.exe).toBeUndefined();
  });

  it('bound appId: appInfo carries process + exe + windowTitle', async () => {
    const deps = makeDeps();
    startRecording(SESSION, WORKSPACE, 'kingdee', deps);
    appendRecordedStep(SESSION, 'mcp__terminator__press_key', { key: 'Enter' });
    const result = await stopRecording(SESSION, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trace.app).toBe('kingdee');
    expect(result.trace.appInfo?.process).toBe('KIS');
    expect(result.trace.appInfo?.exe).toBe(kingdee.exe);
    expect(result.trace.appInfo?.windowTitle).toBe(kingdee.windowTitle);
  });
});


describe('process override (design C: actual-operated app wins over bound default)', () => {
  it('bound A but operating B → appInfo.process is B', async () => {
    const deps = makeDeps();
    startRecording(SESSION, WORKSPACE, 'kingdee', deps);
    // agent actually operates notepad, not kingdee
    appendRecordedStep(SESSION, 'mcp__terminator__invoke_element', {
      process: 'notepad',
      selector: 'MenuItem|name:文件',
    });
    const result = await stopRecording(SESSION, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trace.appInfo?.process).toBe('notepad');
  });
});
