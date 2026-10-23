/**
 * 分节容量裁剪（2.0.8 实机修复）。
 *
 * 背景：蒸馏弧产出的每一节有硬上限（认知弧 2000 字符 / 研究弧按 budget 折算），
 * 旧实现是 `body.slice(0, cap)` —— 直接按字符硬切。实机后果（2026-10-22 日志）：
 *
 *   [distill] 分节 reminders 超过 2000 字符（2349），已截断
 *
 * 被切掉的是**半条 bullet**（`- 提醒内容（来源：…｜日期：` 断在这里），下一轮
 * 蒸馏又把这段残句当成"已有蒸馏内容"喂回模型，模型据此续写 → 越写越歪。
 * 对 reminders 这种"一行一条、每条自带日期"的结构，正确做法是**整条淘汰**，
 * 而且优先淘汰最旧/已过期的（残差守恒：忘了可以，切成残句不行）。
 *
 * 规则：
 * 1. 只淘汰可淘汰行（`- ` / `* ` 开头的条目），非条目行（`### 域：binary` 这类
 *    结构标题、说明段落）**永不优先淘汰**——它们承载分组语义。
 * 2. 淘汰顺序：日期最旧优先；无日期的排在有日期的之后；同日按原文顺序从后往前
 *    （同一批写入的多条，靠后的是较新的滚动产物）。
 * 3. 淘汰后在原位留一行标记，告诉下一轮蒸馏"这里少了几条"，避免它把删减误读成
 *    "这些事不存在了"。
 * 4. 淘汰完仍超预算（说明结构行本身就太长，比如模型写了一整段散文）→ 退回按字符
 *    硬切，并额外告警。这条兜底不能省：宁可切，也不能把超长内容写进库。
 */

/** 可淘汰行：Markdown 列表项。 */
const EVICTABLE_LINE_RE = /^\s*[-*]\s+/;

/** 条目里的日期（蒸馏提示词要求 `日期：YYYY-MM-DD`）。 */
const DATE_RE = /日期[:：]\s*(\d{4})-(\d{2})-(\d{2})/;

export interface CapSectionResult {
  text: string;
  warnings: string[];
  /** 被淘汰的条目数（诊断/测试用）。 */
  evicted: number;
  /** 是否退回了字符硬切。 */
  hardCut: boolean;
}

interface Item {
  text: string;
  /** 淘汰排序键：越小越先淘汰。 */
  rank: number;
  evictable: boolean;
  removed: boolean;
}

/** 年份日期 → 可比较数字；解析不到返回 null。 */
function compactDate(line: string): number | null {
  const m = DATE_RE.exec(line);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  return y * 10000 + mo * 100 + d;
}

/**
 * 按预算裁剪一节正文。纯函数，无 IO。
 *
 * @param body 分节正文（已 trim 与否均可）
 * @param maxChars 硬上限（含淘汰标记的长度）
 * @param label 分节名（只用于告警文案）
 */
export function capSectionByLines(body: string, maxChars: number, label: string): CapSectionResult {
  const trimmed = body.trim();
  if (trimmed.length <= maxChars) {
    return { text: trimmed, warnings: [], evicted: 0, hardCut: false };
  }

  const warnings: string[] = [];
  const lines = trimmed.split('\n');
  const items: Item[] = lines.map((text, i) => {
    const evictable = EVICTABLE_LINE_RE.test(text);
    const date = evictable ? compactDate(text) : null;
    // 排序键：有日期 → 日期本身（小的先淘汰）；无日期 → 极大值（排在日期之后）。
    // 同键时用 -i 让靠后的行先走（滚动更新里，靠后的更新）。
    const rank = date === null ? Number.MAX_SAFE_INTEGER - i : date * 1000 - i;
    return { text, rank, evictable, removed: false };
  });

  const build = (removed: number): string => {
    const kept: string[] = [];
    let markerPlaced = false;
    for (const it of items) {
      if (it.removed) {
        if (!markerPlaced) {
          kept.push(`…（另有 ${removed} 条较早记录因篇幅未纳入，等下次蒸馏滚动）`);
          markerPlaced = true;
        }
        continue;
      }
      kept.push(it.text);
    }
    return kept.join('\n');
  };

  const candidates = items.filter((it) => it.evictable).sort((a, b) => a.rank - b.rank);
  let removed = 0;
  let out = trimmed;
  for (const cand of candidates) {
    // 至少留一条：全淘汰等于这一节空了，那比超长更糟。
    if (removed >= candidates.length - 1) break;
    cand.removed = true;
    removed += 1;
    out = build(removed);
    if (out.length <= maxChars) break;
  }

  if (out.length <= maxChars) {
    warnings.push(
      `分节 ${label} 超过 ${maxChars} 字符（${trimmed.length}），按整条淘汰 ${removed} 条较早记录（未切断条目）`,
    );
    return { text: out, warnings, evicted: removed, hardCut: false };
  }

  // 兜底：结构行本身就超长，只能硬切（并明说）。
  warnings.push(
    `分节 ${label} 淘汰 ${removed} 条后仍超 ${maxChars} 字符（${out.length}），退回按字符硬截断`,
  );
  return { text: out.slice(0, maxChars), warnings, evicted: removed, hardCut: true };
}
