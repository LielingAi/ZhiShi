// Unit tests for the AppCraft sediment-proposal tracker (P2b-1 回溯式沉淀入口,
// 宪章 §6.1/§6.2).
//
// Covers: action-class tool counting (same 口径 as the recorder via
// isAppcraftActionTool → mapToolCallToStep), failure filtering, the ≥2
// threshold, per-session debounce (同会话只提一次), recording suppression,
// and turn-reset semantics. Recording state is started with injected deps —
// no disk, no projects.json — keeping the module in the fast `unit` pool.
import { afterEach, describe, expect, it } from 'vitest';

import {
  isAppcraftActionTool,
  resetRecordingsForTest,
  startRecording,
} from './recorder';
import {
  dropSedimentActionTool,
  evaluateSedimentProposal,
  noteSedimentActionTool,
  resetSedimentProposalForTest,
  resetSedimentTurnTracking,
  SEDIMENT_ACTION_THRESHOLD,
} from './sediment-proposal';

const SESSION = 'sess-1';

afterEach(() => {
  resetSedimentProposalForTest();
  resetRecordingsForTest();
});

// ---------------------------------------------------------------------------
// isAppcraftActionTool — 与录制口径严格一致（动作类 = 能落成 trace step）
// ---------------------------------------------------------------------------

describe('isAppcraftActionTool', () => {
  it('accepts every terminator/cuse action-class tool', () => {
    const actionTools = [
      'mcp__terminator__invoke_element',
      'mcp__terminator__click_element',
      'mcp__terminator__set_value',
      'mcp__terminator__type_into_element',
      'mcp__terminator__press_key',
      'mcp__cuse__click',
      'mcp__cuse__type',
      'mcp__cuse__key',
      'mcp__cuse__scroll',
    ];
    for (const name of actionTools) {
      expect(isAppcraftActionTool(name), name).toBe(true);
    }
  });

  it('rejects perception / lifecycle / non-AppCraft tools', () => {
    const nonActionTools = [
      'mcp__terminator__get_window_tree',
      'mcp__terminator__open_application',
      'mcp__terminator__capture_screenshot',
      'mcp__cuse__screenshot',
      'mcp__playwright__browser_click',
      'Read',
      'Bash',
    ];
    for (const name of nonActionTools) {
      expect(isAppcraftActionTool(name), name).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Tracking + threshold
// ---------------------------------------------------------------------------

describe('evaluateSedimentProposal', () => {
  it('returns null below the action threshold', () => {
    noteSedimentActionTool(SESSION, 'tu-1', 'mcp__terminator__click_element');
    expect(evaluateSedimentProposal(SESSION)).toBeNull();
  });

  it('proposes once the threshold of successful actions is reached', () => {
    noteSedimentActionTool(SESSION, 'tu-1', 'mcp__terminator__click_element');
    noteSedimentActionTool(SESSION, 'tu-2', 'mcp__cuse__type');
    const proposal = evaluateSedimentProposal(SESSION);
    expect(proposal).toEqual({ actionCount: SEDIMENT_ACTION_THRESHOLD });
  });

  it('ignores non-action tools when counting', () => {
    noteSedimentActionTool(SESSION, 'tu-1', 'mcp__terminator__click_element');
    noteSedimentActionTool(SESSION, 'tu-2', 'mcp__terminator__get_window_tree');
    noteSedimentActionTool(SESSION, 'tu-3', 'mcp__cuse__screenshot');
    noteSedimentActionTool(SESSION, 'tu-4', 'Read');
    expect(evaluateSedimentProposal(SESSION)).toBeNull();
  });

  it('drops failed (is_error) calls from the count', () => {
    noteSedimentActionTool(SESSION, 'tu-1', 'mcp__terminator__click_element');
    noteSedimentActionTool(SESSION, 'tu-2', 'mcp__terminator__set_value');
    // 第二次选择器试探失败 → 只剩 1 个成功动作，不达阈值。
    dropSedimentActionTool(SESSION, 'tu-2');
    expect(evaluateSedimentProposal(SESSION)).toBeNull();
  });

  it('survives tool calls without a toolUseId (synthetic keys do not collapse)', () => {
    noteSedimentActionTool(SESSION, undefined, 'mcp__terminator__click_element');
    noteSedimentActionTool(SESSION, undefined, 'mcp__terminator__press_key');
    expect(evaluateSedimentProposal(SESSION)).toEqual({ actionCount: 2 });
  });

  it('turn reset clears the count (fresh turn starts empty)', () => {
    noteSedimentActionTool(SESSION, 'tu-1', 'mcp__terminator__click_element');
    resetSedimentTurnTracking(SESSION);
    noteSedimentActionTool(SESSION, 'tu-2', 'mcp__terminator__click_element');
    expect(evaluateSedimentProposal(SESSION)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 防抖红线：同会话只提一次；未达标不消耗名额
// ---------------------------------------------------------------------------

describe('debounce (同会话同任务只提一次)', () => {
  it('proposes at most once per session, but other sessions are unaffected', () => {
    noteSedimentActionTool(SESSION, 'tu-1', 'mcp__terminator__click_element');
    noteSedimentActionTool(SESSION, 'tu-2', 'mcp__terminator__set_value');
    expect(evaluateSedimentProposal(SESSION)).not.toBeNull();

    // 同会话后续回合又达标 → 不再提议。
    resetSedimentTurnTracking(SESSION);
    noteSedimentActionTool(SESSION, 'tu-3', 'mcp__cuse__click');
    noteSedimentActionTool(SESSION, 'tu-4', 'mcp__cuse__key');
    expect(evaluateSedimentProposal(SESSION)).toBeNull();

    // 别的会话不受影响。
    noteSedimentActionTool('sess-2', 'tu-1', 'mcp__cuse__click');
    noteSedimentActionTool('sess-2', 'tu-2', 'mcp__cuse__type');
    expect(evaluateSedimentProposal('sess-2')).not.toBeNull();
  });

  it('does not consume the one-shot slot when the threshold is not met', () => {
    noteSedimentActionTool(SESSION, 'tu-1', 'mcp__terminator__click_element');
    expect(evaluateSedimentProposal(SESSION)).toBeNull();
    // 后续回合达标 → 仍然可以提议。
    noteSedimentActionTool(SESSION, 'tu-2', 'mcp__terminator__click_element');
    expect(evaluateSedimentProposal(SESSION)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 录制抑制：用户已在走显式录制流时不提议
// ---------------------------------------------------------------------------

describe('recording suppression', () => {
  it('returns null while the session has an active recording', () => {
    const started = startRecording(SESSION, 'E:\\ws\\demo', '', {
      getBoundApps: () => [],
      now: () => new Date('2026-07-30T10:00:00+08:00'),
      writeTraceFile: () => { /* hermetic */ },
    });
    expect(started.ok).toBe(true);

    noteSedimentActionTool(SESSION, 'tu-1', 'mcp__terminator__click_element');
    noteSedimentActionTool(SESSION, 'tu-2', 'mcp__terminator__set_value');
    expect(evaluateSedimentProposal(SESSION)).toBeNull();
    // 抑制不消耗防抖名额：录制结束后的回合若达标仍可提议。
    resetRecordingsForTest();
    expect(evaluateSedimentProposal(SESSION)).not.toBeNull();
  });
});
