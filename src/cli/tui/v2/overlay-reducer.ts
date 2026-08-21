/**
 * overlay 按键归约（1.1.10 B：app.ts 拆分）。
 *
 * 范式同 model.ts 的 reduceHiddenLine：7 种 overlay（completion/help/
 * history/rewind/queue/tasks/drawer + modal 占位）的状态变更全部收在这里
 * 做纯函数归约——返回新 overlay（null = 关闭）+ 可选的副作用描述；
 * app.ts 只负责执行副作用（editor 编辑/submit/网络取消/块重绘）与最后的
 * renderChrome。判定所需的外部数据（编辑器文本/历史清单/任务行数/drawer
 * 总行数）由 app 以 OverlayKeyEnv 显式注入。
 */

import { HELP_ENTRIES } from './commands';
import { HistoryStore } from './history';
import { keyToEdit, hasMod, type Key } from './keymap';
import type { EditAction } from './editor';
import type { ModalState, RefAttachment } from './types';

export interface CompletionEntry {
  label: string;
  detail: string;
  group: string;
  insert: string;
  ref?: RefAttachment;
}

export type Overlay =
  | { kind: 'completion'; source: '/' | '@'; items: CompletionEntry[]; sel: number }
  | { kind: 'help'; sel: number }
  | { kind: 'history'; query: string; results: string[]; sel: number }
  | { kind: 'rewind'; action: 'rewind' | 'fork'; candidates: { srvId: string; label: string }[]; sel: number }
  | { kind: 'queue'; items: { id: string; preview: string; kindLabel: string }[]; sel: number }
  | { kind: 'tasks'; sel: number; detail: boolean; offset: number }
  | { kind: 'drawer'; blockId: string; offset: number }
  | { kind: 'modal'; state: ModalState };

/** reducer 判定所需的外部数据（app 现取注入，reducer 不碰 App/编辑器）。 */
export interface OverlayKeyEnv {
  /** 编辑器当前文本（completion Enter 分支：动词后带空格即提交）。 */
  editorText: string;
  /** 历史清单（newest first）——history 重滤的数据源。 */
  historyTexts: string[];
  /** /tasks 面板行数（Enter 互切与移动夹紧的上界）。 */
  taskRowCount: number;
  /** /tasks 详情页当前内容总行数（offset 滚动夹紧上界；非详情态为 0）。 */
  taskDetailTotal: number;
  /** drawer 目标块总行数；块不存在/非 tool → null（关面板）。 */
  drawerTotal: number | null;
  /** U5(1.1.10):最近 N 个 tool 块 id(旧→新)——drawer ←/→ 切换的候选环。 */
  drawerToolIds: string[];
}

/** 归约出的副作用：app 按 type 执行，reducer 自身零副作用。 */
export type OverlayEffect =
  | { type: 'accept-completion' }
  | { type: 'submit' }
  | { type: 'editor-edit'; edit: EditAction }
  | { type: 'history-pick'; text: string | undefined }
  | { type: 'rewind-go'; action: 'rewind' | 'fork'; srvId: string }
  | { type: 'queue-cancel'; id: string }
  | { type: 'tasks-open-detail' }
  | { type: 'drawer-repaint'; blockId: string; prevBlockId?: string };

export interface OverlayKeyResult {
  overlay: Overlay | null;
  effect?: OverlayEffect;
}

/** 历史搜索重滤（原 app.refilterHistory）：query 空 → 全量(newest first)。 */
export function filterHistoryResults(query: string, texts: string[]): string[] {
  return query ? texts.filter((t) => HistoryStore.score(query, t) > 0) : texts;
}

/**
 * overlay 按键归约。esc 逐层退出（tasks 详情先退回列表）；其余按 overlay
 * 种类分派。未识别的键原样返回（effect 缺省,app 仍补一次 renderChrome,
 * 与原 onOverlayKey 的落点一致）。
 */
export function reduceOverlayKey(ov: Overlay, key: Key, env: OverlayKeyEnv): OverlayKeyResult {
  if (key.name === 'esc') {
    // tasks 详情页：Esc 先逐层退回列表，再按才关面板（overlay 惯例）。
    if (ov.kind === 'tasks' && ov.detail) return { overlay: { ...ov, detail: false, offset: 0 } };
    return { overlay: null };
  }
  switch (ov.kind) {
    case 'completion': {
      if (key.name === 'up') return { overlay: { ...ov, sel: Math.max(0, ov.sel - 1) } };
      if (key.name === 'down') return { overlay: { ...ov, sel: Math.min(ov.items.length - 1, ov.sel + 1) } };
      if (key.name === 'tab') return { overlay: ov, effect: { type: 'accept-completion' } };
      if (key.name === 'enter') {
        // Enter = accept the highlighted completion ONLY while the user is
        // still typing the bare command. Once args begin (a space follows
        // the verb) or nothing matches, Enter must SUBMIT the text — the
        // first cut swallowed '/snapshot tui-live' into the void here.
        if (ov.items.length === 0 || /\s/.test(env.editorText.slice(1))) {
          return { overlay: null, effect: { type: 'submit' } };
        }
        return { overlay: ov, effect: { type: 'accept-completion' } };
      }
      // typing continues into the editor, live-filtering the panel
      const edit = keyToEdit(key);
      if (edit) return { overlay: ov, effect: { type: 'editor-edit', edit } };
      return { overlay: ov };
    }
    case 'help': {
      if (key.name === 'up') return { overlay: { ...ov, sel: Math.max(0, ov.sel - 1) } };
      if (key.name === 'down') return { overlay: { ...ov, sel: Math.min(HELP_ENTRIES.length - 1, ov.sel + 1) } };
      if (hasMod(key, 'ctrl') && key.char === 'l') return { overlay: null };
      return { overlay: ov };
    }
    case 'history': {
      if (key.name === 'up') return { overlay: { ...ov, sel: Math.max(0, ov.sel - 1) } };
      if (key.name === 'down') return { overlay: { ...ov, sel: Math.min(ov.results.length - 1, ov.sel + 1) } };
      if (key.name === 'enter') {
        return { overlay: null, effect: { type: 'history-pick', text: ov.results[ov.sel] } };
      }
      if (key.name === 'backspace') {
        const query = ov.query.slice(0, -1);
        return { overlay: { ...ov, query, results: filterHistoryResults(query, env.historyTexts), sel: 0 } };
      }
      if (key.char && !hasMod(key, 'ctrl')) {
        const query = ov.query + key.char;
        return { overlay: { ...ov, query, results: filterHistoryResults(query, env.historyTexts), sel: 0 } };
      }
      return { overlay: ov };
    }
    case 'rewind': {
      if (key.name === 'up') return { overlay: { ...ov, sel: Math.max(0, ov.sel - 1) } };
      if (key.name === 'down') return { overlay: { ...ov, sel: Math.min(ov.candidates.length - 1, ov.sel + 1) } };
      if (key.name === 'enter' && ov.candidates[ov.sel]) {
        const sel = ov.candidates[ov.sel];
        return { overlay: null, effect: { type: 'rewind-go', action: ov.action, srvId: sel.srvId } };
      }
      return { overlay: ov };
    }
    case 'queue': {
      if (key.name === 'up') return { overlay: { ...ov, sel: Math.max(0, ov.sel - 1) } };
      if (key.name === 'down') return { overlay: { ...ov, sel: Math.min(ov.items.length - 1, ov.sel + 1) } };
      if ((key.char === 'x' || key.name === 'enter') && ov.items[ov.sel]) {
        const item = ov.items[ov.sel];
        const items = [...ov.items];
        items.splice(ov.sel, 1);
        const sel = Math.max(0, Math.min(ov.sel, items.length - 1));
        return {
          overlay: items.length === 0 ? null : { ...ov, items, sel },
          effect: { type: 'queue-cancel', id: item.id },
        };
      }
      return { overlay: ov };
    }
    case 'tasks': {
      // 列表/详情两层：Enter 互切；列表层 ↑/↓ 移选,详情层 ↑/↓/PgUp/PgDn
      // 滚动 offset（transcript 可能很长,1.1.10 A′）。
      const rows = env.taskRowCount;
      if (key.name === 'enter') {
        if (rows > 0) {
          if (!ov.detail) {
            // 打开详情:offset 归零 + 通知 app 按需拉 transcript(副作用)。
            return { overlay: { ...ov, detail: true, offset: 0 }, effect: { type: 'tasks-open-detail' } };
          }
          return { overlay: { ...ov, detail: false, offset: 0 } };
        }
        return { overlay: ov };
      }
      if (!ov.detail) {
        if (key.name === 'up') return { overlay: { ...ov, sel: Math.max(0, ov.sel - 1) } };
        if (key.name === 'down') return { overlay: { ...ov, sel: Math.min(rows - 1, ov.sel + 1) } };
      } else {
        const maxOffset = Math.max(0, env.taskDetailTotal - 1);
        if (key.name === 'up') return { overlay: { ...ov, offset: Math.max(0, ov.offset - 1) } };
        if (key.name === 'down') return { overlay: { ...ov, offset: Math.min(maxOffset, ov.offset + 1) } };
        if (key.name === 'pgup') return { overlay: { ...ov, offset: Math.max(0, ov.offset - 10) } };
        if (key.name === 'pgdn') return { overlay: { ...ov, offset: Math.min(maxOffset, ov.offset + 10) } };
      }
      return { overlay: ov };
    }
    case 'drawer': {
      if (env.drawerTotal === null) return { overlay: null };
      const total = env.drawerTotal;
      const repaint: OverlayEffect = { type: 'drawer-repaint', blockId: ov.blockId };
      if (hasMod(key, 'ctrl') && key.char === 'o') return { overlay: null, effect: repaint };
      // U5(1.1.10):←/→ 在最近 N 个 tool 卡间循环切换目标(单卡时原地不动)。
      if (key.name === 'left' || key.name === 'right') {
        const ids = env.drawerToolIds;
        const idx = ids.indexOf(ov.blockId);
        if (ids.length < 2 || idx < 0) return { overlay: ov, effect: repaint };
        const dir = key.name === 'left' ? -1 : 1;
        const to = ids[(idx + dir + ids.length) % ids.length];
        return {
          overlay: { kind: 'drawer', blockId: to, offset: 0 },
          effect: { type: 'drawer-repaint', blockId: to, prevBlockId: ov.blockId },
        };
      }
      if (key.name === 'up') return { overlay: { ...ov, offset: Math.max(0, ov.offset - 1) }, effect: repaint };
      if (key.name === 'down') return { overlay: { ...ov, offset: Math.min(total - 1, ov.offset + 1) }, effect: repaint };
      if (key.name === 'pgup') return { overlay: { ...ov, offset: Math.max(0, ov.offset - 10) }, effect: repaint };
      if (key.name === 'pgdn') return { overlay: { ...ov, offset: Math.min(total - 1, ov.offset + 10) }, effect: repaint };
      return { overlay: ov, effect: repaint };
    }
    case 'modal':
      // modal 在 onKey 前置分支吞键（只答 y/n），不会路由到这里。
      return { overlay: ov };
  }
}
