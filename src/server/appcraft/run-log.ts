/**
 * AppCraft run log（作品架账本，COWORK_logic §6 任务5：能力成长叙事）。
 *
 * 每次回放追加一行到 `<workspace>/.appcraft/runs.jsonl`；SOP 续跑的
 * `sop-heals.jsonl` 是"它自己修好了"的证据（P2b-2 已建）。两个 JSONL
 * 聚合出每个 skill 的"成长叙事"：替你跑过几次、顺利几次、自己修好过几次。
 *
 * 宪章 §6.4：能力越用越准——账本让"越用"可见。Best-effort：写失败
 * 绝不影响回放本身（账本是外化，不是执行的一部分）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppcraftRunRecord {
  ts: string;
  id: string;
  kind: 'skill' | 'recording';
  success: boolean;
  executedSteps: number;
  stepCount: number;
  failedStep?: number;
}

/** 聚合后的成长叙事。 */
export interface AppcraftRunStats {
  totalRuns: number;
  okRuns: number;
  lastRunAt: string | null;
  /** SOP 续跑（"它自己修好了"）次数。 */
  heals: number;
  lastHealAt: string | null;
}

// ---------------------------------------------------------------------------
// Append（回放完成时调用，best-effort）
// ---------------------------------------------------------------------------

export type RunLogWriter = (path: string, line: string) => void;

function defaultWriter(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line, 'utf-8');
}

/** 追加一行回放记录。写失败只告警，绝不抛。 */
export function appendAppcraftRun(
  workspacePath: string,
  record: AppcraftRunRecord,
  writer: RunLogWriter = defaultWriter,
): void {
  try {
    writer(join(workspacePath, '.appcraft', 'runs.jsonl'), `${JSON.stringify(record)}\n`);
  } catch (err) {
    console.warn(
      `[appcraft/run-log] append failed for '${record.id}':`,
      err instanceof Error ? err.message : err,
    );
  }
}

// ---------------------------------------------------------------------------
// Aggregate（list 时调用）
// ---------------------------------------------------------------------------

function readJsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, 'utf-8')
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((r): r is Record<string, unknown> => r !== null);
  } catch {
    return [];
  }
}

/**
 * 聚合 runs.jsonl + sop-heals.jsonl → 每个 skill/recording id 的成长叙事。
 * 纯函数（输入两个文件路径，文件缺失即空），可测。
 */
export function aggregateAppcraftRunStats(workspacePath: string): Map<string, AppcraftRunStats> {
  const stats = new Map<string, AppcraftRunStats>();
  const ensure = (id: string): AppcraftRunStats => {
    let s = stats.get(id);
    if (!s) {
      s = { totalRuns: 0, okRuns: 0, lastRunAt: null, heals: 0, lastHealAt: null };
      stats.set(id, s);
    }
    return s;
  };

  for (const r of readJsonl(join(workspacePath, '.appcraft', 'runs.jsonl'))) {
    if (typeof r.id !== 'string') continue;
    const s = ensure(r.id);
    s.totalRuns += 1;
    if (r.success === true) s.okRuns += 1;
    if (typeof r.ts === 'string' && (s.lastRunAt === null || r.ts > s.lastRunAt)) s.lastRunAt = r.ts;
  }

  for (const r of readJsonl(join(workspacePath, '.appcraft', 'sop-heals.jsonl'))) {
    if (typeof r.skill !== 'string') continue;
    const s = ensure(r.skill);
    s.heals += 1;
    if (typeof r.ts === 'string' && (s.lastHealAt === null || r.ts > s.lastHealAt)) s.lastHealAt = r.ts;
  }

  return stats;
}
