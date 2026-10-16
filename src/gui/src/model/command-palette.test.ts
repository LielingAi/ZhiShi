/**
 * V4-S3 命令中枢（Ctrl+K）纯函数层单测。
 *
 * 覆盖 paletteItems 三态推导：
 *   空输入 → 「最近」节（history 前 4）+ 按 group 分节的动词目录；
 *   动词前缀 → 按命令名段过滤（同 slash overlay 口径）；
 *   精确动词+空格 → slashObjectItems 对象模式（复用注册表；null 回落
 *     动词过滤且保留已输参数——/snapshot my 不许丢 my）。
 * 另覆盖历史落盘：LRU 去重置顶、8 条截断、坏值回落。
 */

import { describe, expect, it } from 'vitest';

import type { CampaignRecordLike } from './campaign';
import type { LineRow } from './lines';
import { MISSION_OPTIONS } from './mission';
import {
  loadPaletteHistory,
  PALETTE_HISTORY_LIMIT,
  paletteItems,
  pushPaletteHistoryList,
  savePaletteHistory,
  type PaletteSources,
} from './command-palette';

// 动词目录固件（结构同 store 的 SLASH_COMMANDS——模型层不 import store，
// 避免拖进模块级单例破坏 unit 池纯度）。
const COMMANDS = [
  { name: 'attach', detail: '接管环境 shell', group: '环境' },
  { name: 'snapshot', detail: '打快照 [名]', group: '环境' },
  { name: 'reset', detail: '重置对话', group: '线程' },
  { name: 'resume', detail: '切线', group: '线' },
  { name: 'kill', detail: '终止战役', group: '战役' },
  { name: 'mission', detail: '改形态', group: '形态' },
  { name: 'model', detail: '选择模型', group: '配置' },
];

const LINE: LineRow = {
  id: 'muz47v0z-aaaa',
  envKey: 'dev',
  segLabel: '我',
  ownerLabel: '我',
  shared: false,
  stateDot: 'running',
  active: true,
  updatedLabel: '12:00',
  canShare: true,
  canUnshare: false,
};

const CAMPAIGN: CampaignRecordLike = { id: 'cmp-1', goal: '挖 libpng 崩溃面', state: 'running', signalLog: [] };

function sources(over: Partial<PaletteSources> = {}): PaletteSources {
  return {
    lines: [LINE],
    campaigns: [CAMPAIGN],
    missions: MISSION_OPTIONS,
    envs: [],
    runningIds: new Set(),
    slashCommands: COMMANDS,
    history: [],
    ...over,
  };
}

describe('paletteItems — 空输入目录态', () => {
  it('先「最近」（history 前 4，新→旧），后按 group 分节的动词目录', () => {
    const history = ['/reset', '/snapshot s1', '/kill cmp-1', '/resume muz47v0z-aaaa', '/model'];
    const items = paletteItems('', sources({ history }));
    const recent = items.filter((i) => i.kind === 'history');
    expect(recent.map((i) => i.runCmdline)).toEqual(history.slice(0, 4));
    expect(recent.every((i) => i.group === '最近')).toBe(true);
    const verbs = items.filter((i) => i.kind === 'verb');
    expect(verbs).toHaveLength(COMMANDS.length);
    expect(verbs.map((i) => i.runCmdline)).toEqual(COMMANDS.map((c) => `/${c.name}`));
    // group 标签随目录逐行携带（UI 在 group 变化处画分节头）。
    expect(verbs.map((i) => i.group)).toEqual(COMMANDS.map((c) => c.group));
  });

  it('空白/裸 "/" 同样进目录态；无历史则没有「最近」节', () => {
    expect(paletteItems('', sources()).every((i) => i.kind === 'verb')).toBe(true);
    expect(paletteItems('  ', sources()).every((i) => i.kind === 'verb')).toBe(true);
    expect(paletteItems('/', sources()).every((i) => i.kind === 'verb')).toBe(true);
  });
});

describe('paletteItems — 动词前缀过滤', () => {
  it('按命令名段 startsWith（同 slash overlay 口径）；带不带 / 等价', () => {
    expect(paletteItems('resu', sources()).map((i) => i.title)).toEqual(['/resume']);
    expect(paletteItems('/resu', sources()).map((i) => i.title)).toEqual(['/resume']);
    expect(paletteItems('s', sources()).map((i) => i.title)).toEqual(['/snapshot']);
  });

  it('无匹配 → 空数组（面板显无匹配提示）', () => {
    expect(paletteItems('zzz', sources())).toEqual([]);
  });
});

describe('paletteItems — 精确动词+空格 → 对象模式', () => {
  it('注册表动词出对象候选：runCmdline = /cmd 对象id；参数段过滤对象', () => {
    const all = paletteItems('resume ', sources());
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      kind: 'object',
      title: LINE.id,
      tag: '线',
      runCmdline: `/resume ${LINE.id}`,
    });
    expect(paletteItems('resume nomatch', sources())).toEqual([]);
  });

  it('对象模式未命中注册表 → 回落动词过滤且保留已输参数（/snapshot my 不丢 my）', () => {
    const items = paletteItems('snapshot my', sources());
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'verb', title: '/snapshot', runCmdline: '/snapshot my' });
  });

  it('kill/mission 对象源直读注入数据源', () => {
    expect(paletteItems('kill ', sources()).map((i) => i.runCmdline)).toEqual(['/kill cmp-1']);
    const missions = paletteItems('mission ', sources());
    expect(missions.length).toBe(MISSION_OPTIONS.length);
    expect(missions[0].runCmdline).toBe(`/mission ${MISSION_OPTIONS[0].label}`);
  });
});

describe('paletteHistory（LRU 去重置顶 + 8 条截断）', () => {
  it('新条目置顶；重复条目去重后置顶（LRU）', () => {
    expect(pushPaletteHistoryList(['/a', '/b'], '/c')).toEqual(['/c', '/a', '/b']);
    expect(pushPaletteHistoryList(['/a', '/b'], '/b')).toEqual(['/b', '/a']);
  });

  it('截断到 8 条；空串/纯空白不入库', () => {
    const ten = Array.from({ length: 10 }, (_, i) => `/c${i}`);
    expect(pushPaletteHistoryList(ten, '/new')).toHaveLength(PALETTE_HISTORY_LIMIT);
    expect(pushPaletteHistoryList(['/a'], '   ')).toEqual(['/a']);
  });

  it('落盘 roundtrip；坏值（非 JSON/非数组/非串）回落空数组', () => {
    const mem = new Map<string, string>();
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
    };
    savePaletteHistory(storage, ['/a', '/b']);
    expect(loadPaletteHistory(storage)).toEqual(['/a', '/b']);
    mem.set('zhishi.gui.paletteHistory', '{nope');
    expect(loadPaletteHistory(storage)).toEqual([]);
    mem.set('zhishi.gui.paletteHistory', '{"x":1}');
    expect(loadPaletteHistory(storage)).toEqual([]);
    mem.set('zhishi.gui.paletteHistory', '[1,"/a"]');
    expect(loadPaletteHistory(storage)).toEqual(['/a']);
  });
});
