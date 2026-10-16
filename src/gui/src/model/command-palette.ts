/**
 * V4-S3 命令中枢（Ctrl+K 面板）纯函数层——候选推导 + 执行历史落盘。
 *
 * 一门两窗：输入行 `/` overlay 与 Ctrl+K 面板共用同一执行引擎
 * （runSlashCommand，经 store 的 execSlashCommand 出口）与同一对象补全
 * 注册表（model/slash-objects）。本层只推导「输入文本 × 数据源 → 候选」，
 * 不复制过滤逻辑：动词口径直接复用 slash-input 的 name 段解析，对象模式
 * 直接调 slashObjectItems（null = 无对象表，回落动词过滤——与 overlay
 * 同语义，参数段不丢）。
 *
 * 纯函数：不 import store / React / client。
 */

import { parseSlashInput, slashNameSegment } from './slash-input';
import { slashObjectItems, type SlashObjectSources } from './slash-objects';

/** 命令中枢候选行。 */
export interface PaletteItem {
  /** 动词=/name；对象=对象 id；历史=完整 cmdline。 */
  kind: 'verb' | 'object' | 'history';
  /** 展示标题。 */
  title: string;
  detail?: string;
  tag?: string;
  /** 目录分节名（空输入的「最近」+ group 分节；过滤/对象态不留节）。 */
  group?: string;
  /** 选中后的完整命令行 /cmd args（pickPalette 的执行/回填依据）。 */
  runCmdline: string;
}

/** 候选推导数据源（store 快照注入；slashCommands 结构同 SLASH_COMMANDS）。 */
export interface PaletteSources extends SlashObjectSources {
  slashCommands: Array<{ name: string; detail: string; group: string }>;
  /** 最近执行历史（新→旧；openPalette 时从 localStorage 载）。 */
  history: string[];
}

/** 「最近」节条数（目录态的召回钩子——完整历史不落面板，防噪音）。 */
export const PALETTE_RECENT_LIMIT = 4;

/** 执行历史上限（LRU；localStorage 持久化）。 */
export const PALETTE_HISTORY_LIMIT = 8;

/** localStorage 存储键。 */
const PALETTE_HISTORY_KEY = 'zhishi.gui.paletteHistory';

function verbItem(
  c: { name: string; detail: string; group: string },
  args: string,
  group?: string,
): PaletteItem {
  return {
    kind: 'verb',
    title: `/${c.name}`,
    detail: c.detail,
    tag: c.group,
    ...(group !== undefined ? { group } : {}),
    // 已输参数随行携带——/snapshot my 回落动词过滤后选中仍直执行，不丢 my。
    runCmdline: args ? `/${c.name} ${args}` : `/${c.name}`,
  };
}

function historyItem(cmdline: string): PaletteItem {
  return { kind: 'history', title: cmdline, group: '最近', runCmdline: cmdline };
}

/**
 * 输入文本 → 候选列表：
 *   空输入        → 「最近」节（history 前 4）+ 按 group 逐行带签的动词目录；
 *   动词前缀      → 按命令名段 startsWith 过滤（slash overlay 同口径）；
 *   精确动词+空格 → slashObjectItems 对象模式；返回 null 回落动词过滤。
 *
 * 输入带不带前导 / 等价（内部统一补 / 走 parseSlashInput）。
 */
export function paletteItems(text: string, src: PaletteSources): PaletteItem[] {
  const raw = text.startsWith('/') ? text : `/${text}`;
  if (!parseSlashInput(raw)) {
    return [
      ...src.history.slice(0, PALETTE_RECENT_LIMIT).map(historyItem),
      ...src.slashCommands.map((c) => verbItem(c, '', c.group)),
    ];
  }
  const nameSeg = slashNameSegment(raw);
  const parsed = parseSlashInput(raw);
  const args = parsed?.args ?? '';
  const exactHit = src.slashCommands.some((c) => c.name === nameSeg);
  if (exactHit && /\s/.test(text)) {
    const objects = slashObjectItems({ name: nameSeg, args }, src);
    if (objects !== null) {
      return objects.map((o) => ({
        kind: 'object',
        title: o.name,
        detail: o.detail,
        tag: o.tag,
        runCmdline: `/${nameSeg} ${o.name}`,
      }));
    }
  }
  const q = nameSeg.toLowerCase();
  return src.slashCommands
    .filter((c) => !q || c.name.startsWith(q))
    .map((c) => verbItem(c, args));
}

// ---------------------------------------------------------------------------
// 执行历史落盘（LRU；读写异常静默——隐私模式等，照 input-history 口径）
// ---------------------------------------------------------------------------

export interface PaletteHistoryStorage {
  getItem(key: string): string | null;
  setItem?(key: string, value: string): void;
}

/** 读历史（非法 JSON / 非数组 / 非字符串条目过滤；超截断条数丢弃尾部）。 */
export function loadPaletteHistory(storage: PaletteHistoryStorage | null | undefined): string[] {
  try {
    const raw = storage?.getItem(PALETTE_HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is string => typeof x === 'string' && x.length > 0)
      .slice(0, PALETTE_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

/** 写历史（失败静默）。 */
export function savePaletteHistory(
  storage: PaletteHistoryStorage | null | undefined,
  list: string[],
): void {
  try {
    storage?.setItem?.(PALETTE_HISTORY_KEY, JSON.stringify(list));
  } catch {
    // 静默。
  }
}

/** 去重置顶 + 截断（trim 后为空不入库——同 prependHistory 口径）。 */
export function pushPaletteHistoryList(list: string[], cmdline: string): string[] {
  const t = cmdline.trim();
  if (!t) return list;
  return [t, ...list.filter((x) => x !== t)].slice(0, PALETTE_HISTORY_LIMIT);
}
