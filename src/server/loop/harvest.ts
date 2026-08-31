/**
 * 1.5.3 — 收割（harvest）：压缩点被裁段的确定性状态提取 + 侧车落盘。
 *
 * 治本三层分离（流/状态/指针，用户拍板定稿）的执行层：
 *   - 流：jsonl 全量在盘上（历史真相，不动）；
 *   - 状态：档案 + 研究记录 + 收割侧车（本文件）——被裁段的关键事实先沉淀，
 *     裁剪不再等于丢失；
 *   - 指针：上下文里的指针卡（段号 + 相位 + 结论引用 + jsonl 行区间 +
 *     harvest #K）——模型「知道内容在哪」，用 recall 工具取回。
 *
 * 收割是确定性的（规则提取，零模型调用——不赌模型主动）：toolResult 段
 * 提取命令+exit code+关键行（flag/CVE/错误形态/路径），assistant 段取结论
 * 摘要，用户消息全文必保（用户指令永不裁——1.5.3 硬钉死）。
 *
 * 落点纪律：会话侧车 `<loop-sessions>/<sessionId>.harvest.jsonl`——与
 * archive 同目录同纪律（withFileLock 锁内读-改-写 + writeFileAtomic
 * tmp+rename）。**不借 refs**（large-value-store TTL 1h + 60s 周期 GC 会
 * 蒸发指针目标——1.5.3 方案审核实锤）。
 *
 * 结构：收割/提取是纯函数（可单测零 IO）；appendHarvestEntries/loadHarvest
 * 是仅有的 IO。
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getZhiShiDataDir } from '../utils/app-dirs';
import { withFileLock, writeFileAtomic } from '../utils/file-lock';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

import type { ContextSegment } from './context-manager';
import { messageText } from './context-manager';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface HarvestEntry {
  /** K#N（收割条目编号，会话内递增）。 */
  id: string;
  /** 来源段号（ContextSegment.index）。 */
  segmentIndex: number;
  phase: string;
  /** jsonl 行区间（含两端）：消息下标 i → 行 i+2（行 1 是 meta）。 */
  lineStart: number;
  lineEnd: number;
  /** 段内 user 消息原文（必保——用户指令永不裁，收割时单独留全文）。 */
  userTexts: string[];
  /** toolResult 提取的关键行（命令/exit/flag/CVE/错误形态/路径）。 */
  keyFacts: string[];
  /** assistant 结论摘要（text 块首句，各截 200 字符）。 */
  summaries: string[];
  /** 段内工具名录。 */
  tools: string[];
  createdAt: string;
}

export interface HarvestStoreOptions {
  /** 存储目录（测试注入临时目录；默认 loop-sessions 目录）。 */
  dir?: string;
}

// ---------------------------------------------------------------------------
// 纯函数 — 收割提取（确定性规则，零模型调用）
// ---------------------------------------------------------------------------

/** 关键行模式：命令/退出码/flag/CVE/错误形态/绝对路径。 */
const KEY_FACT_LINE = /(?:^|\b)(?:exit=|flag\{|CVE-\d{4}-\d+|SIGSEGV|SIGABRT|SIGILL|SIGFPE|panic:|fatal|\berror\b|\/[\w./-]+\.[a-z0-9]{1,6}\b)/i;
const KEY_FACT_MAX_PER_SEGMENT = 8;
const KEY_FACT_LINE_MAX = 160;
const SUMMARY_MAX = 200;
const USER_TEXT_MAX = 400;

function clipLine(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** 消息 → 角色（pi AgentMessage 的 role 字段）。 */
function roleOf(m: AgentMessage): string {
  return (m as { role?: string }).role ?? '';
}

/** 段 → 收割条目（纯函数；id 由落盘侧分配）。 */
export function harvestSegment(
  seg: Pick<ContextSegment, 'index' | 'phase' | 'start' | 'end' | 'toolNames'>,
  messages: readonly AgentMessage[],
): Omit<HarvestEntry, 'id' | 'createdAt'> {
  const userTexts: string[] = [];
  const keyFacts: string[] = [];
  const summaries: string[] = [];
  for (let i = seg.start; i < seg.end && i < messages.length; i++) {
    const m = messages[i];
    const role = roleOf(m);
    const text = messageText(m);
    if (!text.trim()) continue;
    if (role === 'user') {
      userTexts.push(clipLine(text, USER_TEXT_MAX));
      continue;
    }
    if (role === 'toolResult') {
      for (const line of text.split('\n')) {
        if (keyFacts.length >= KEY_FACT_MAX_PER_SEGMENT) break;
        if (KEY_FACT_LINE.test(line)) keyFacts.push(clipLine(line, KEY_FACT_LINE_MAX));
      }
      continue;
    }
    if (role === 'assistant') {
      const firstLine = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
      if (firstLine) summaries.push(clipLine(firstLine, SUMMARY_MAX));
    }
  }
  return {
    segmentIndex: seg.index,
    phase: seg.phase,
    lineStart: seg.start + 2,
    lineEnd: seg.end - 1 + 2,
    userTexts,
    keyFacts,
    summaries: summaries.slice(0, 4),
    tools: [...seg.toolNames],
  };
}

/** 指针卡文本（stub 的 1.5.3 形态——含收割引用 + jsonl 行区间 + recall 用法）。
 *  行区间直接印在卡上：模型可不等 ref 取回、直接 recall({lines:"x-y"}) 拿原文（A1-3）。 */
export function buildPointerCard(
  seg: Pick<ContextSegment, 'index' | 'phase' | 'toolNames' | 'keyHits'>,
  harvestId: string,
  lines: { lineStart: number; lineEnd: number },
): string {
  const keys = seg.keyHits.length > 0 ? seg.keyHits.map((l) => `「${l}」`).join(' ') : '无关键命中';
  const tools = seg.toolNames.length > 0 ? seg.toolNames.join('/') : '无工具调用';
  return (
    `[段#${seg.index} ${seg.phase} 已沉淀] 关键信息:${keys};工具:${tools};` +
    `全文在会话存档 jsonl 第 ${lines.lineStart}-${lines.lineEnd} 行` +
    `（recall({lines:"${lines.lineStart}-${lines.lineEnd}"}) 按行区间取回原文）；` +
    `收割物:${harvestId}（recall({ref:"${harvestId}"}) 取回摘要与关键行）。`
  );
}

// ---------------------------------------------------------------------------
// IO — 侧车读写（锁内读-改-写 + tmp+rename，照 archive.ts 纪律）
// ---------------------------------------------------------------------------

function harvestFile(sessionId: string, dir: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '');
  return join(dir, `${safe}.harvest.jsonl`);
}

function harvestDir(options?: HarvestStoreOptions): string {
  return options?.dir ?? join(getZhiShiDataDir(), 'loop-sessions');
}

/** 读收割侧车（缺失/损坏 → 空数组——读侧容错，压缩不因收割故障阻塞）。 */
export function loadHarvest(sessionId: string, options?: HarvestStoreOptions): HarvestEntry[] {
  const file = harvestFile(sessionId, harvestDir(options));
  if (!existsSync(file)) return [];
  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  const out: HarvestEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as HarvestEntry;
      if (typeof e.id === 'string' && typeof e.segmentIndex === 'number') out.push(e);
    } catch {
      /* 坏行跳过，不炸整文件 */
    }
  }
  return out;
}

/** 追加收割条目（锁内读-改-写；分配 K#N 编号；返回带 id 的条目）。 */
export async function appendHarvestEntries(
  sessionId: string,
  entries: Array<Omit<HarvestEntry, 'id' | 'createdAt'>>,
  options?: HarvestStoreOptions,
): Promise<HarvestEntry[]> {
  const dir = harvestDir(options);
  mkdirSync(dir, { recursive: true });
  const file = harvestFile(sessionId, dir);
  const now = new Date().toISOString();
  let assigned: HarvestEntry[] = [];
  await withFileLock({ lockPath: `${file}.lock` }, async () => {
    const existing = loadHarvest(sessionId, options);
    let maxSeq = 0;
    for (const e of existing) {
      const hit = /^K#(\d+)$/.exec(e.id);
      if (hit) maxSeq = Math.max(maxSeq, Number(hit[1]));
    }
    assigned = entries.map((e) => ({ ...e, id: `K#${++maxSeq}`, createdAt: now }));
    const body = existing.concat(assigned).map((e) => JSON.stringify(e)).join('\n') + '\n';
    writeFileAtomic(file, body);
  });
  return assigned;
}

/** 按 id 读单条收割物（recall({ref:"K#n"}) 的执行面）。 */
export function readHarvestEntry(
  sessionId: string,
  id: string,
  options?: HarvestStoreOptions,
): HarvestEntry | null {
  return loadHarvest(sessionId, options).find((e) => e.id === id) ?? null;
}
