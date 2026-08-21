// 1.1.9 P1 增量折行的正确性验收（property 风格）。
//
// 模型：随机文本（CJK / emoji ZWJ / VS16 / 组合符 / 控制符 / \n）随机分成
// 多 span、随机样式，再随机切 chunk 流式「update」——每个中间态都同时算
// 增量（rewrapAppended，失败则回退全量）与全量 wrapSpans，二者必须逐行
// 逐 segment 深相等。另加 markdown renderAssistant 真实 spans 的流式场景，
// 以及针对追加形态判定的一组定向用例（命中 / 回退各若干）。
import { describe, expect, it } from 'vitest';

import { renderAssistant } from './blocks/message-block';
import type { Span } from './row-buffer';
import {
  rewrapAppended,
  wrapSpans,
  wrapSpansTracked,
  type WrapEntry,
} from './terminal-writer';

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) — 失败可复现。
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STYLES: Array<Span['style']> = [
  undefined,
  { fg: 'cyan' },
  { fg: 'cyan', bold: true },
  { fg: 'purple', bg: 'panel' },
  { fg: 'amber' },
  { fg: 'faint', dim: true },
  { bold: true },
];

/** 覆盖：ASCII / CJK 宽字符 / VS16 emoji / ZWJ 序列 / 组合符 / 控制符 / 换行。 */
const PIECES = [
  'a',
  'b',
  'Z',
  '0',
  ' ',
  '你',
  '好',
  '中',
  '文',
  '✈️',
  '👩‍💻',
  '🎯',
  'é', // e + U+0301 combining acute
  '\n',
  '\t',
  '`',
  '*',
  '#',
  '-',
  '·',
];

function randomText(rand: () => number, maxLen: number): string {
  const n = Math.floor(rand() * maxLen);
  let out = '';
  for (let i = 0; i < n; i++) out += PIECES[Math.floor(rand() * PIECES.length)];
  return out;
}

function randomSpans(rand: () => number): Span[] {
  const n = 1 + Math.floor(rand() * 6);
  const spans: Span[] = [];
  for (let i = 0; i < n; i++) {
    spans.push({
      text: randomText(rand, 40),
      style: STYLES[Math.floor(rand() * STYLES.length)],
    });
  }
  return spans;
}

/** 截取 spans 的前缀（spanIdx 个完整 span + 第 spanIdx 个的前 offset 码元）。 */
function cutAt(spans: Span[], spanIdx: number, offset: number): Span[] {
  const out = spans.slice(0, spanIdx).map((s) => ({ ...s }));
  out.push({
    text: spans[spanIdx].text.slice(0, offset),
    style: spans[spanIdx].style,
  });
  return out;
}

interface StreamStats {
  hits: number; // 增量路径命中次数
  falls: number; // 回退全量次数
}

/** 流式重放 states，每个中间态的折行结果必须与全量 wrapSpans 深相等。 */
function streamAssert(states: Span[][], width: number): StreamStats {
  let entry: WrapEntry | null = null;
  let prev: Span[] | null = null;
  const stats: StreamStats = { hits: 0, falls: 0 };
  for (const next of states) {
    const inc: WrapEntry | null =
      entry && prev ? rewrapAppended(prev, next, entry, width) : null;
    let result: WrapEntry;
    if (inc) {
      result = inc;
      stats.hits++;
    } else {
      result = wrapSpansTracked(next, width);
      stats.falls++;
    }
    expect(result.lines).toEqual(wrapSpans(next, width));
    entry = result;
    prev = next;
  }
  return stats;
}

// ---------------------------------------------------------------------------

describe('rewrapAppended 定向形态判定', () => {
  const W = 8;
  const track = (spans: Span[]) => wrapSpansTracked(spans, W);
  const CARET: Span = { text: '▍', style: { fg: 'faint' } };

  it('命中：末 span 增长（无尾缀）', () => {
    const prev: Span[] = [{ text: '你好 wor' }];
    const next: Span[] = [{ text: '你好 world abc' }];
    const got = rewrapAppended(prev, next, track(prev), W);
    expect(got).not.toBeNull();
    expect(got!.lines).toEqual(wrapSpans(next, W));
  });

  it('命中：恒定尾缀（流式光标 ▍）前的 span 增长', () => {
    const prev: Span[] = [{ text: 'hello' }, CARET];
    const next: Span[] = [{ text: 'hello world, 你好' }, CARET];
    const got = rewrapAppended(prev, next, track(prev), W);
    expect(got).not.toBeNull();
    expect(got!.lines).toEqual(wrapSpans(next, W));
  });

  it('命中：末尾纯插入新 span', () => {
    const prev: Span[] = [{ text: 'ab' }];
    const next: Span[] = [{ text: 'ab' }, { text: '中文✈️', style: { fg: 'cyan' } }];
    const got = rewrapAppended(prev, next, track(prev), W);
    expect(got).not.toBeNull();
    expect(got!.lines).toEqual(wrapSpans(next, W));
  });

  it('命中：增长 span 之后还插入了新 span（尾缀前移）', () => {
    const prev: Span[] = [{ text: 'aa' }, { text: 'TAIL', style: { fg: 'amber' } }];
    const next: Span[] = [
      { text: 'aabb' },
      { text: 'NEW', style: { fg: 'cyan' } },
      { text: 'TAIL', style: { fg: 'amber' } },
    ];
    const got = rewrapAppended(prev, next, track(prev), W);
    expect(got).not.toBeNull();
    expect(got!.lines).toEqual(wrapSpans(next, W));
  });

  it('回退：文本缩短', () => {
    const prev: Span[] = [{ text: 'hello world' }];
    const next: Span[] = [{ text: 'hello' }];
    expect(rewrapAppended(prev, next, track(prev), W)).toBeNull();
  });

  it('回退：中间 span 文本变了（markdown 重解析）', () => {
    const prev: Span[] = [{ text: 'x `cod' }, CARET];
    const next: Span[] = [
      { text: 'x ' },
      { text: 'code', style: { fg: 'purple' } },
      CARET,
    ];
    expect(rewrapAppended(prev, next, track(prev), W)).toBeNull();
  });

  it('回退：追加 span 的 style 变了', () => {
    const prev: Span[] = [{ text: 'ab', style: { fg: 'cyan' } }];
    const next: Span[] = [{ text: 'abcd', style: { fg: 'red' } }];
    expect(rewrapAppended(prev, next, track(prev), W)).toBeNull();
  });

  it('命中：chunk 把 grapheme 簇切成两半（✈ + VS16 分两次到达）', () => {
    // 被切开的簇必在末行，随尾段整体重折 —— 增量结果仍与全量逐字节相等。
    const prev: Span[] = [{ text: '✈' }];
    const next: Span[] = [{ text: '✈️x' }]; // ✈️ = ✈ + U+FE0F，单簇宽 2
    const got = rewrapAppended(prev, next, track(prev), W);
    expect(got).not.toBeNull();
    expect(got!.lines).toEqual(wrapSpans(next, W));
  });

  it('回退：插在开头（spans 数量不变但整体后移）', () => {
    const prev: Span[] = [{ text: 'b' }];
    const next: Span[] = [{ text: 'a' }, { text: 'b' }];
    // 前缀 p=0、尾缀 s=1 → oldMid=0、k=-1 → 插在开头，回退
    expect(rewrapAppended(prev, next, track(prev), W)).toBeNull();
  });
});

describe('rewrapAppended property：随机多 span 随机切 chunk', () => {
  const WIDTHS = [2, 3, 5, 8, 40];
  let totalHits = 0;
  let totalFalls = 0;

  for (let seed = 1; seed <= 40; seed++) {
    it(`seed ${seed}：每个中间态都与全量折行深相等`, () => {
      const rand = mulberry32(seed);
      const final = randomSpans(rand);
      // 随机递增切点序列（码元级，允许切断簇 → 该步回退全量）。
      const positions: Array<[number, number]> = [];
      for (let si = 0; si < final.length; si++) {
        const len = final[si].text.length;
        const cuts = Math.floor(rand() * 3);
        for (let c = 0; c < cuts; c++)
          positions.push([si, 1 + Math.floor(rand() * len)]);
      }
      positions.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const states = positions.map(([si, off]) => cutAt(final, si, off));
      states.push(final.map((s) => ({ ...s })));
      const width = WIDTHS[seed % WIDTHS.length];
      const stats = streamAssert(states, width);
      totalHits += stats.hits;
      totalFalls += stats.falls;
      expect(stats.hits + stats.falls).toBe(states.length);
    });
  }

  it('增量路径确实大量命中（不是全程回退）', () => {
    // 40 个 seed 跑完后汇总：只有每个 seed 的首态（冷启动）回退全量，
    // 其余 chunk 全部是合法追加、必须走增量。
    expect(totalFalls).toBe(40);
    expect(totalHits).toBeGreaterThan(100);
  });
});

describe('rewrapAppended property：markdown 真实 spans 流式', () => {
  // 与 app.ts flattenLines 同逻辑（app 未导出；此处本地复刻，见 m9 bench）。
  function flattenLines(lines: Span[][]): Span[] {
    const out: Span[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) out.push({ text: '\n' });
      out.push(...lines[i]);
    }
    return out;
  }

  const DOC = [
    '## 标题一\n',
    '\n',
    '正文 **加粗** 与 `inline code` 混排，中文 English 交替。✈️\n',
    '- 列表项一\n',
    '- 列表项二 👩‍💻\n',
    '\n',
    '```c\n',
    'int main() { return 0; }\n',
    '```\n',
    '\n',
    '1. 有序一\n',
    '2. 有序二\n',
    '\n',
    '结尾段落，足够长以便在窄宽度下折出多行 visual line，覆盖宽度回绕与 \\n 断行两条路径。',
  ].join('');

  for (const width of [4, 17, 60]) {
    it(`width ${width}：随机 chunk 流式 renderAssistant 逐态相等`, () => {
      const rand = mulberry32(1000 + width);
      // 随机码元切点（含切断簇的可能），递增。
      const cuts = new Set<number>();
      for (let i = 0; i < 60; i++)
        cuts.add(1 + Math.floor(rand() * DOC.length));
      const points = [...cuts].sort((a, b) => a - b);
      points.push(DOC.length);
      const states = points.map((end) =>
        flattenLines(
          renderAssistant(
            {
              kind: 'assistant',
              id: 'a',
              text: DOC.slice(0, end),
              seq: 0,
              complete: false,
              streaming: true,
            },
            true, // streaming → 尾部恒定 ▍ 光标
            false,
          ),
        ),
      );
      const stats = streamAssert(states, width);
      // markdown 重解析会造成部分回退，但纯追加 chunk 必须占多数。
      expect(stats.hits).toBeGreaterThan(stats.falls);
    });
  }
});
