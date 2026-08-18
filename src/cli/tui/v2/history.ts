/**
 * history (plan §2.9). Persists the input history to
 * ~/.zhishi/tui-history.jsonl (one {ts, env, text} per line). Loads the last
 * 1000 entries on startup; Ctrl+R fuzzy search reuses the completion panel
 * presentation (see completion.ts) — this module only owns persistence +
 * the fuzzy match scorer.
 */

import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface HistoryEntry {
  ts: number;
  env: string;
  text: string;
}

export class HistoryStore {
  private path: string;
  private entries: HistoryEntry[] = [];

  constructor(envName: string, dataDir?: string) {
    const base = dataDir ?? join(homedir(), '.zhishi');
    this.path = join(base, 'tui-history.jsonl');
    try {
      mkdirSync(base, { recursive: true });
      const raw = readFileSync(this.path, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          this.entries.push(JSON.parse(line));
        } catch {
          /* skip corrupt line */
        }
      }
    } catch {
      /* no history yet */
    }
  }

  /**
   * Recent texts in editor order: oldest first, newest last (LineEditor's
   * historyStep(-1) walks backwards from length-1 to 0, i.e. up = most recent).
   * Dedupe keeps the most recent occurrence of each text.
   */
  recentTexts(limit = 1000): string[] {
    const newestFirst: string[] = [];
    for (let i = this.entries.length - 1; i >= 0 && newestFirst.length < limit; i--) {
      const t = this.entries[i].text;
      if (!newestFirst.includes(t)) newestFirst.push(t);
    }
    return newestFirst.reverse();
  }

  append(text: string, env: string): void {
    const t = text.trim();
    if (!t) return;
    const entry: HistoryEntry = { ts: Date.now(), env, text: t };
    this.entries.push(entry);
    try {
      appendFileSync(this.path, JSON.stringify(entry) + '\n', 'utf8');
    } catch {
      /* best-effort */
    }
  }

  /**
   * Subsequence fuzzy score (fzf-lite): higher = better. 0 = no match.
   * Bonuses: contiguous runs, word-start hits, prefix hit.
   */
  static score(query: string, candidate: string): number {
    if (!query) return 1;
    const q = query.toLowerCase();
    const c = candidate.toLowerCase();
    let qi = 0;
    let score = 0;
    let run = 0;
    let prevMatch = -2;
    for (let i = 0; i < c.length && qi < q.length; i++) {
      if (c[i] === q[qi]) {
        run = prevMatch === i - 1 ? run + 2 : 0;
        score += 1 + run;
        if (i === 0 || /[\s/:@-]/.test(c[i - 1])) score += 3;
        prevMatch = i;
        qi++;
      }
    }
    return qi === q.length ? score : 0;
  }
}
