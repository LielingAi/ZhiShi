/**
 * 崩溃件检查器纯函数层（第四批 v4 落地——crash 对象双击→检查器）。
 *
 * 数据源是 admin research/list（SettingsPage 研究页签同端点）——它是混桶
 * 端点：recon / vuln-hunt / fuzz 等 taskKind 都落同一张表。崩溃分拣结论
 * 只来自 fuzz 桶（crash-triager 落库），所以 parse 的第一道闸就是
 * taskKind==='fuzz'——其余桶的行与崩溃无关，不过滤会把研究事件混进
 * 崩溃面板。
 *
 * 匹配是两级：先 bugClass 精确（chip 指纹与 triager 结论同串时零误收），
 * 再无精确时 includes 收拢同族变体——campaign 侧 crashClasses chips 与
 * triager 落库 bugClass 来自两条路径，指纹粒度会漂移（一方带 -read
 * 后缀一方不带），两级兼顾准确与召回。无匹配返回 []：是否回落全量由
 * 调用方决定，本函数不做隐式放宽。
 *
 * 纯函数：不 import store / React / client；单测见 crash-events.test.ts。
 */

import type { ResearchEventRow } from '../client/api';
import { formatLineUpdated } from './lines';

// ---------------------------------------------------------------------------
// 记录窄化
// ---------------------------------------------------------------------------

/** 崩溃事件（research/list fuzz 桶行的最小展示面）。 */
export interface CrashEvent {
  /** 服务端行 id（旧行可能缺省 → null）。 */
  id: number | null;
  workspace?: string;
  /** triager 判定（unique / duplicate / security / bug …）。 */
  outcome?: string;
  /** triager 结论文本（多行）。 */
  summary?: string;
  /** 崩溃类指纹（crash-triager 归类结果；与 campaign crashClasses 同源）。 */
  bugClass?: string;
  /** ISO-8601；旧行可能缺失。 */
  createdAt?: string;
}

function strOf(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function numOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 空行判定：指纹与结论双缺——这种行没有展示价值，挡在面板外。 */
function isBlank(r: ResearchEventRow): boolean {
  return !strOf(r.bugClass) && !strOf(r.summary);
}

/**
 * research/list 行 → 崩溃事件数组：只留 fuzz 桶非空行，按 createdAt
 * 倒序（最新在前——与信号 feed 同语义）。输入形状不合返回 [] 不抛。
 */
export function parseCrashEvents(rows: ResearchEventRow[]): CrashEvent[] {
  if (!Array.isArray(rows)) return [];
  const out: CrashEvent[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    if (raw.taskKind !== 'fuzz' || isBlank(raw)) continue;
    out.push({
      id: numOf(raw.id),
      workspace: strOf(raw.workspace),
      outcome: strOf(raw.outcome),
      summary: strOf(raw.summary),
      bugClass: strOf(raw.bugClass),
      createdAt: strOf(raw.createdAt),
    });
  }
  // 时间倒序；createdAt 缺失的行排最后（不丢——triager 旧行可能无时间戳）。
  out.sort((a, b) => {
    const ta = a.createdAt ? Date.parse(a.createdAt) : Number.NEGATIVE_INFINITY;
    const tb = b.createdAt ? Date.parse(b.createdAt) : Number.NEGATIVE_INFINITY;
    return tb - ta;
  });
  return out;
}

// ---------------------------------------------------------------------------
// 指纹匹配（两级）
// ---------------------------------------------------------------------------

/**
 * 按指纹收相关事件：精确 → includes 两级。精确命中直接返回（不被
 * includes 的同族项稀释）；无精确再 includes 收拢；最终无匹配返回 []
 * （回落全量由调用方决定）。
 */
export function matchCrashClass(events: CrashEvent[], fingerprint: string): CrashEvent[] {
  const fp = fingerprint.trim();
  if (!fp) return [];
  const exact = events.filter((e) => e.bugClass === fp);
  if (exact.length > 0) return exact;
  return events.filter((e) => e.bugClass !== undefined && e.bugClass.includes(fp));
}

// ---------------------------------------------------------------------------
// 挂证据到档案（1.9.20 第一批——archive/op 的 evidence 入参装配）
// ---------------------------------------------------------------------------

/**
 * evidence 正文上限：照注入口径（archive.ts renderArchiveForInjection 的
 * oneLine 200）——实体本身无硬字符上限，但注入段单行截 200，超长此后的
 * 正文无增量价值；全文在检查器面板/复制结论里拿得到。
 */
export const EVIDENCE_TEXT_MAX = 200;

/** archive/op 的 evidence 入参（字段名照服务端 archiveParameters 契约：
 *  op/text 必填语义 + anchor 来源标注——admin-archive.ts::handleArchiveOp
 *  原样透传进 createArchiveTool 执行体）。 */
export interface ArchiveEvidencePayload {
  op: 'evidence';
  text: string;
  anchor?: string;
}

/**
 * 崩溃事件 → evidence 入参：content = `bugClass：summary`（无 summary 兜底
 * bugClass 单行，双缺留空由 store 挡下）；anchor = crash-triager fuzz 桶 +
 * 落库时间（anchor 纪律标「证据在流的哪里」，这里标「谁在何时落库」）。
 */
export function evidencePayloadOf(ev: CrashEvent): ArchiveEvidencePayload {
  const bugClass = ev.bugClass?.trim();
  const summary = ev.summary?.trim();
  let text = bugClass && summary ? `${bugClass}：${summary}` : (bugClass ?? summary ?? '');
  if (text.length > EVIDENCE_TEXT_MAX) text = `${text.slice(0, EVIDENCE_TEXT_MAX - 1)}…`;
  const when = ev.createdAt ? formatLineUpdated(ev.createdAt) : '';
  const anchor = `crash-triager fuzz 桶${when ? ` · ${when}` : ''}`;
  return { op: 'evidence', text, anchor };
}

// ---------------------------------------------------------------------------
// 显示辅助
// ---------------------------------------------------------------------------

/** 单行标题：指纹优先；缺指纹回落 fuzz#id（再缺 → fuzz#?）。 */
export function crashEventTitle(e: CrashEvent): string {
  if (e.bugClass) return e.bugClass;
  return `fuzz#${e.id ?? '?'}`;
}
