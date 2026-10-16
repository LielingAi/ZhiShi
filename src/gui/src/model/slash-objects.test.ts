/**
 * slash-objects.test.ts — v4 命令对象补全纯函数层单测。
 *
 * 覆盖：slashObjectItems 注册表推导——
 *   resume：args 按线 id 过滤（includes、大小写不敏感），detail = envKey ·
 *     状态标签，tag = 线；lines 为空返回空数组（overlay 显示无匹配，不是 null）。
 *   kill：args 按战役 id 与 goal 过滤，detail = goal，tag = 战役。
 *   mission：常量表五形态（中文标签），args 过滤标签（大小写不敏感），
 *     name = 标签（选中后映射回 kind——CTF 全大写标签也要能吃小写输入）。
 *   其他命令 → null（维持原命令名前缀过滤）。
 */
import { describe, expect, it } from 'vitest';

import type { CampaignRecordLike } from './campaign';
import type { LineRow } from './lines';
import { MISSION_OPTIONS } from './mission';
import { LINE_STATE_LABELS, slashObjectItems, type SlashObjectSources } from './slash-objects';

function line(over: Partial<LineRow>): LineRow {
  return {
    id: 'muz47v0z-1111-2222-3333-444455556666',
    envKey: 'dev',
    segLabel: '我',
    ownerLabel: '我',
    shared: false,
    stateDot: 'running',
    active: false,
    updatedLabel: '12:00',
    canShare: true,
    canUnshare: false,
    ...over,
  };
}

function campaign(over: Partial<CampaignRecordLike>): CampaignRecordLike {
  return {
    id: 'cmp-abc',
    goal: '挖 libpng 解析崩溃面',
    state: 'running',
    signalLog: [],
    ...over,
  };
}

const sources = (over: Partial<SlashObjectSources> = {}): SlashObjectSources => ({
  lines: [
    line({ id: 'muz47v0z-aaaa', envKey: 'dev', stateDot: 'running' }),
    line({ id: 'qbt99k2x-bbbb', envKey: 'pwn', stateDot: 'idle' }),
    line({ id: 'winter7-cold1', envKey: 'dev', stateDot: 'cold' }),
  ],
  campaigns: [
    campaign({ id: 'cmp-abc', goal: '挖 libpng 解析崩溃面' }),
    campaign({ id: 'cmp-def', goal: '复现 CVE-2024-1234', state: 'paused' }),
  ],
  missions: MISSION_OPTIONS,
  // V4-S4 /use 动词对象源：环境注册表 + 运行状态（runningIds）。
  envs: [],
  runningIds: new Set(),
  ...over,
});

describe('slashObjectItems — use（环境对象，V4-S4 正门中途切环境）', () => {
  const envs = [
    { id: 'env:pwn-vm', kind: 'vm' as const, name: 'pwn 靶机' },
    { id: 'env:dev-box', kind: 'docker' as const },
  ];

  it('对象 = 环境注册表；detail = 运行状态（runningIds 现场判定）', () => {
    const items = slashObjectItems(
      { name: 'use', args: '' },
      sources({ envs, runningIds: new Set(['env:pwn-vm']) }),
    );
    expect(items).toEqual([
      { name: 'env:pwn-vm', detail: '运行中', tag: '环境' },
      { name: 'env:dev-box', detail: '已停止', tag: '环境' },
    ]);
  });

  it('按 id/name 过滤（大小写不敏感）', () => {
    expect(
      slashObjectItems({ name: 'use', args: 'PWN' }, sources({ envs, runningIds: new Set() }))!.map((i) => i.name),
    ).toEqual(['env:pwn-vm']);
    expect(
      slashObjectItems({ name: 'use', args: '靶机' }, sources({ envs, runningIds: new Set() }))!.map((i) => i.name),
    ).toEqual(['env:pwn-vm']);
  });
});

describe('slashObjectItems — 非对象命令返回 null', () => {
  it('路由表/本地命令/未知命令 → null（维持命令名前缀过滤）', () => {
    const src = sources();
    expect(slashObjectItems({ name: 'snapshot', args: '' }, src)).toBeNull();
    expect(slashObjectItems({ name: 'intel', args: 'CVE' }, src)).toBeNull();
    expect(slashObjectItems({ name: 'attach', args: '' }, src)).toBeNull();
    expect(slashObjectItems({ name: 'nonsense', args: '' }, src)).toBeNull();
  });
});

describe('slashObjectItems — resume（线对象）', () => {
  it('空 args → 全部线；tag=线，detail=envKey · 状态标签', () => {
    const items = slashObjectItems({ name: 'resume', args: '' }, sources());
    expect(items).toHaveLength(3);
    expect(items?.map((i) => i.tag)).toEqual(['线', '线', '线']);
    expect(items?.[0]).toEqual({
      name: 'muz47v0z-aaaa',
      detail: `dev · ${LINE_STATE_LABELS.running}`,
      tag: '线',
    });
    expect(items?.[1].detail).toBe(`pwn · ${LINE_STATE_LABELS.idle}`);
    expect(items?.[2].detail).toBe(`dev · ${LINE_STATE_LABELS.cold}`);
  });

  it('args 按 id includes 过滤，大小写不敏感', () => {
    const items = slashObjectItems({ name: 'resume', args: 'MUZ47' }, sources());
    expect(items?.map((i) => i.name)).toEqual(['muz47v0z-aaaa']);
    const none = slashObjectItems({ name: 'resume', args: 'zzz' }, sources());
    expect(none).toEqual([]);
  });

  it('lines 为空 → 空数组（overlay 显示无匹配，区别于 null）', () => {
    const items = slashObjectItems({ name: 'resume', args: '' }, sources({ lines: [] }));
    expect(items).toEqual([]);
  });
});

describe('slashObjectItems — kill（战役对象）', () => {
  it('空 args → 全部战役；tag=战役，detail=goal', () => {
    const items = slashObjectItems({ name: 'kill', args: '' }, sources());
    expect(items).toHaveLength(2);
    expect(items?.[0]).toEqual({ name: 'cmp-abc', detail: '挖 libpng 解析崩溃面', tag: '战役' });
  });

  it('args 命中 id 或 goal（includes、大小写不敏感）', () => {
    expect(slashObjectItems({ name: 'kill', args: 'cmp-def' }, sources())?.map((i) => i.name)).toEqual(['cmp-def']);
    expect(slashObjectItems({ name: 'kill', args: 'libpng' }, sources())?.map((i) => i.name)).toEqual(['cmp-abc']);
    expect(slashObjectItems({ name: 'kill', args: 'cve-2024' }, sources())?.map((i) => i.name)).toEqual(['cmp-def']);
    expect(slashObjectItems({ name: 'kill', args: '不存在' }, sources())).toEqual([]);
  });

  it('goal 为空 → detail 回落 id（detail 不留空）', () => {
    const items = slashObjectItems(
      { name: 'kill', args: '' },
      sources({ campaigns: [campaign({ id: 'cmp-x', goal: '' })] }),
    );
    expect(items?.[0].detail).toBe('cmp-x');
  });
});

describe('slashObjectItems — mission（形态常量表）', () => {
  it('空 args → 五形态；tag=形态，name=中文标签', () => {
    const items = slashObjectItems({ name: 'mission', args: '' }, sources());
    expect(items?.map((i) => i.name)).toEqual(['无类型', '挖掘', '利用', '复现', 'CTF']);
    expect(items?.map((i) => i.tag)).toEqual(['形态', '形态', '形态', '形态', '形态']);
  });

  it('args 过滤中文标签；CTF 全大写标签吃小写输入（大小写不敏感）', () => {
    expect(slashObjectItems({ name: 'mission', args: '挖掘' }, sources())?.map((i) => i.name)).toEqual(['挖掘']);
    expect(slashObjectItems({ name: 'mission', args: 'ctf' }, sources())?.map((i) => i.name)).toEqual(['CTF']);
    expect(slashObjectItems({ name: 'mission', args: '类型' }, sources())?.map((i) => i.name)).toEqual(['无类型']);
    expect(slashObjectItems({ name: 'mission', args: 'zzz' }, sources())).toEqual([]);
  });
});
