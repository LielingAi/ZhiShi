/**
 * SSE 事件名对账（2026-08-06 审计 F-01 的防复发机制）。
 *
 * F-01 的教训：`appcraft:sediment-proposal` 后端在 broadcast、前端有 handler，
 * 但 SseConnection 白名单漏注册 → 事件被静默丢弃，功能死亡且无任何报错，
 * 纯模块单测根本测不到链路。本测试把注册表漂移变成 CI 红灯：
 *
 *   后端 broadcast('<event>', …) 字面量全集
 *     ⊆ src/server/sse.ts 的 SSE_EVENT_PRIORITIES
 *
 * 历史三方对账中的 `src/renderer/api/SseConnection.ts` 白名单一腿随 renderer
 * GUI 一并删除（CLI 形态暂无事件白名单；若后续 CLI 引入白名单，应在此恢复
 * 第二腿对账）。
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, it } from 'vitest';

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const SSE_TS = join(SERVER_DIR, 'sse.ts');

/** Recursively collect .ts files under dir (excluding tests). */
function collectSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...collectSources(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.unit.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** All `broadcast('event-name'` / `emitSse('event-name'` literals across the sidecar. */
function backendEmittedEvents(): Set<string> {
  const events = new Set<string>();
  const pattern = /\b(?:broadcast|emitSse|send)\(\s*'([a-z][a-z0-9:-]+)'/g;
  for (const file of collectSources(SERVER_DIR)) {
    const text = readFileSync(file, 'utf-8');
    for (const m of text.matchAll(pattern)) events.add(m[1]);
  }
  return events;
}

/** Events registered in the sidecar priority table. */
function priorityTable(): Set<string> {
  const text = readFileSync(SSE_TS, 'utf-8');
  const events = new Set<string>();
  for (const m of text.matchAll(/^\s*'([a-z][a-z0-9:-]+)':\s*'(?:critical|coalescible|droppable)'/gm)) {
    events.add(m[1]);
  }
  return events;
}

describe('SSE event-name cross-check (audit F-01 regression guard)', () => {
  const emitted = backendEmittedEvents();
  const priorities = priorityTable();

  it('backend emits at least one event (sanity — the extraction works)', () => {
    expect(emitted.size).toBeGreaterThan(10);
  });

  it('every backend-emitted event has an explicit SSE priority (no fail-closed warn noise)', () => {
    const missing = [...emitted].filter((e) => !priorities.has(e));
    expect(missing).toEqual([]);
  });
});
