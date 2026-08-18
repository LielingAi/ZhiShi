import { describe, it, expect } from "vitest";

import {
  isAppcraftTrace,
  parseAppcraftTrace,
  extractVariableCandidates,
  parameterizeTrace,
  classifyStepRisk,
  type AppcraftTrace,
} from "./appcraft-trace";

/** Minimal legal trace per contract §4.1. */
function makeTrace(overrides: Partial<AppcraftTrace> = {}): AppcraftTrace {
  return {
    version: 1,
    app: "kingdee",
    recordedAt: "2026-07-19T10:00:00+08:00",
    steps: [
      {
        action: "uia_click",
        channel: "uia",
        locator: {
          controlType: "Button",
          name: "导出",
          automationId: "btnExport",
        },
        params: {},
        assert: { windowTitle: "导出成功*" },
        fallback: "ai_vision",
        keyframe: "frames/step0.png",
      },
    ],
    ...overrides,
  };
}

describe("isAppcraftTrace", () => {
  it("accepts an object with numeric version and steps array", () => {
    expect(isAppcraftTrace({ version: 1, steps: [] })).toBe(true);
    expect(isAppcraftTrace(makeTrace())).toBe(true);
  });

  it("rejects non-objects and structurally invalid shapes", () => {
    expect(isAppcraftTrace(null)).toBe(false);
    expect(isAppcraftTrace(undefined)).toBe(false);
    expect(isAppcraftTrace("trace")).toBe(false);
    expect(isAppcraftTrace([])).toBe(false);
    expect(isAppcraftTrace({ version: "1", steps: [] })).toBe(false);
    expect(isAppcraftTrace({ version: 1 })).toBe(false);
    expect(isAppcraftTrace({ version: 1, steps: {} })).toBe(false);
  });
});

describe("parseAppcraftTrace", () => {
  it("round-trips a full contract-schema trace", () => {
    const trace = makeTrace();
    const parsed = parseAppcraftTrace(JSON.parse(JSON.stringify(trace)));
    expect(parsed).toEqual(trace);
  });

  it("returns null for structurally invalid input", () => {
    expect(parseAppcraftTrace(null)).toBeNull();
    expect(parseAppcraftTrace({ steps: [] })).toBeNull();
    expect(parseAppcraftTrace({ version: 1 })).toBeNull();
  });

  it("is lenient: defaults missing app/recordedAt, drops malformed steps", () => {
    const parsed = parseAppcraftTrace({
      version: 1,
      steps: [
        { action: "click", channel: "vision", params: { x: 10, y: 20 } },
        { channel: "uia" }, // no action → dropped
        "garbage", // not an object → dropped
        {
          action: "uia_click",
          channel: "telepathy",
          locator: "bad",
          params: 42,
        },
      ],
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.app).toBe("");
    expect(parsed!.recordedAt).toBe("");
    expect(parsed!.steps).toHaveLength(2);
    // Unknown channel degrades to 'vision'; malformed locator/params omitted.
    expect(parsed!.steps[1].channel).toBe("vision");
    expect(parsed!.steps[1].locator).toBeUndefined();
    expect(parsed!.steps[1].params).toBeUndefined();
  });

  it("parses an empty-steps trace (legal, if useless, recording)", () => {
    const parsed = parseAppcraftTrace({
      version: 1,
      app: "a",
      recordedAt: "t",
      steps: [],
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.steps).toEqual([]);
  });
});

describe("extractVariableCandidates", () => {
  it("extracts month/date/amount/filename/quoted-text with merged step indexes", () => {
    const trace = makeTrace({
      steps: [
        {
          action: "uia_set_value",
          channel: "uia",
          locator: { controlType: "Edit", name: "期间" },
          params: { value: "2026-06" },
        },
        {
          action: "type",
          channel: "vision",
          params: { text: "导出 2026-06 报表.xlsx，金额 ¥1,234.50 元" },
        },
        {
          action: "uia_set_value",
          channel: "uia",
          params: { value: "2026-06", memo: "截止到2026年6月30日" },
        },
        {
          action: "type",
          channel: "vision",
          params: { text: '发送给 "张三" 确认' },
        },
      ],
    });

    const candidates = extractVariableCandidates(trace);
    const byPlaceholder = new Map(candidates.map((c) => [c.placeholder, c]));

    // 月份: same literal in steps 0 and 2 merges into one candidate.
    expect(byPlaceholder.get("{{月份}}")).toEqual({
      placeholder: "{{月份}}",
      original: "2026-06",
      stepIndexes: [0, 1, 2],
    });
    // 日期 inside step 2's memo (distinct from the month).
    expect(byPlaceholder.get("{{日期}}")?.original).toBe("2026年6月30日");
    expect(byPlaceholder.get("{{日期}}")?.stepIndexes).toEqual([2]);
    // 金额.
    expect(byPlaceholder.get("{{金额}}")?.original).toBe("¥1,234.50");
    // 文件名.
    expect(byPlaceholder.get("{{文件名}}")?.original).toBe("报表.xlsx");
    // 引号字符串 → 文本 (inner content, without the quotes).
    expect(byPlaceholder.get("{{文本}}")?.original).toBe("张三");
  });

  it("does not match the month inside a full date (date wins on overlap)", () => {
    const trace = makeTrace({
      steps: [
        { action: "type", channel: "vision", params: { text: "2026-06-30" } },
      ],
    });
    const candidates = extractVariableCandidates(trace);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].placeholder).toBe("{{日期}}");
    expect(candidates[0].original).toBe("2026-06-30");
  });

  it("numbers placeholders per type in first-seen order", () => {
    const trace = makeTrace({
      steps: [
        {
          action: "type",
          channel: "vision",
          params: { a: "2026-06", b: "2026-07" },
        },
      ],
    });
    const candidates = extractVariableCandidates(trace);
    const originals = candidates.map((c) => [c.placeholder, c.original]);
    expect(originals).toContainEqual(["{{月份}}", "2026-06"]);
    expect(originals).toContainEqual(["{{月份2}}", "2026-07"]);
  });

  it("ignores already-parameterized placeholders and scans only locator/params", () => {
    const trace = makeTrace({
      steps: [
        {
          action: "uia_set_value",
          channel: "uia",
          params: { value: "{{月份}}" },
          assert: { windowTitle: "2026-06 导出成功*" }, // assert is not scanned
          keyframe: "frames/2026-06.png", // keyframe is not scanned
        },
      ],
    });
    expect(extractVariableCandidates(trace)).toEqual([]);
  });
});

describe("parameterizeTrace", () => {
  it("replaces literals with placeholders in locator and params (not assert)", () => {
    const trace = makeTrace({
      steps: [
        {
          action: "uia_set_value",
          channel: "uia",
          locator: { controlType: "Edit", name: "2026-06 期间" },
          params: { value: "2026-06", nested: { list: ["报表 2026-06"] } },
          assert: { windowTitle: "2026-06 导出成功*" },
        },
      ],
    });

    const parameterized = parameterizeTrace(trace, { "2026-06": "月份" });

    expect(parameterized.steps[0].locator?.name).toBe("{{月份}} 期间");
    expect(parameterized.steps[0].params?.value).toBe("{{月份}}");
    expect(
      (parameterized.steps[0].params?.nested as { list: string[] }).list[0],
    ).toBe("报表 {{月份}}");
    // assert untouched — cuse does not substitute variables there.
    expect(parameterized.steps[0].assert?.windowTitle).toBe(
      "2026-06 导出成功*",
    );
    // Input not mutated.
    expect(trace.steps[0].params?.value).toBe("2026-06");
  });

  it("accepts brace-wrapped mapping values verbatim", () => {
    const trace = makeTrace({
      steps: [
        { action: "type", channel: "vision", params: { text: "2026-06" } },
      ],
    });
    const parameterized = parameterizeTrace(trace, { "2026-06": "{{月份}}" });
    expect(parameterized.steps[0].params?.text).toBe("{{月份}}");
  });

  it("replaces longer literals first so a date beats its month prefix", () => {
    const trace = makeTrace({
      steps: [
        { action: "type", channel: "vision", params: { text: "2026-06-30" } },
      ],
    });
    const parameterized = parameterizeTrace(trace, {
      "2026-06": "月份",
      "2026-06-30": "日期",
    });
    expect(parameterized.steps[0].params?.text).toBe("{{日期}}");
  });

  it("round-trips with extractVariableCandidates output", () => {
    const trace = makeTrace({
      steps: [
        {
          action: "uia_set_value",
          channel: "uia",
          params: { value: "2026-06" },
        },
        {
          action: "type",
          channel: "vision",
          params: { text: "保存为 报表.xlsx" },
        },
      ],
    });

    const candidates = extractVariableCandidates(trace);
    const mapping = Object.fromEntries(
      candidates.map((c) => [c.original, c.placeholder]),
    );
    const parameterized = parameterizeTrace(trace, mapping);

    expect(parameterized.steps[0].params?.value).toBe("{{月份}}");
    expect(parameterized.steps[1].params?.text).toBe("保存为 {{文件名}}");

    // The parameterized trace is still a legal trace, and a second extraction
    // finds nothing left to parameterize.
    expect(
      parseAppcraftTrace(JSON.parse(JSON.stringify(parameterized))),
    ).toEqual(parameterized);
    expect(extractVariableCandidates(parameterized)).toEqual([]);
  });
});


// ---------------------------------------------------------------------------
// classifyStepRisk (PRD §6.8)
// ---------------------------------------------------------------------------

describe('classifyStepRisk', () => {
  it('flags irreversible/outbound locator names as high', () => {
    expect(classifyStepRisk({ action: 'uia_click', channel: 'uia', locator: { name: '发送' } })).toBe('high');
    expect(classifyStepRisk({ action: 'uia_click', channel: 'uia', locator: { name: '删除' } })).toBe('high');
    expect(classifyStepRisk({ action: 'uia_click', channel: 'uia', locator: { name: 'Submit' } })).toBe('high');
  });

  it('flags high-risk typed text as high', () => {
    expect(
      classifyStepRisk({ action: 'uia_set_value', channel: 'uia', params: { text: '确认支付' } }),
    ).toBe('high');
  });

  it('treats benign steps as normal', () => {
    expect(classifyStepRisk({ action: 'uia_click', channel: 'uia', locator: { name: '文件' } })).toBe('normal');
    expect(classifyStepRisk({ action: 'key', channel: 'command', params: { key: 'Escape' } })).toBe('normal');
    expect(classifyStepRisk({ action: 'uia_set_value', channel: 'uia', params: { text: '月度报表' } })).toBe('normal');
  });
});
