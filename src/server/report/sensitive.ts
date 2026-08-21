/**
 * 1.2.0 — 报告敏感项扫描与脱敏（纯函数）。
 *
 * 规则源自 loop/output-guard.ts 的宿主敏感材料识别（credential-echo），
 * 出报告方向补上安全研究产物特有的两类：flag 与内网 IP。两处语义不同：
 *   - output-guard 是「环境回传 → 进模型上下文」，命中整块净化（保守）；
 *   - 这里是「骨架 → 写进宿主报告文件」，用于两处：
 *     1) 导出闸门的知情计数（「flag×1 密钥×2 内网 IP×3」列进批准模态，
 *        知情在人，不替人删）；
 *     2) sanitize:true 时的逐命中遮蔽（`[redacted:类别]`，局部掩码）。
 *
 * 模式全部带 global 标志（计数/遮蔽按出现次数结算）；test/matchAll 前
 * 模式对象不复用跨调用状态（每次 scan 现场构造 lastIndex 无关的用法）。
 */

export interface SensitiveHit {
  category: string;
  count: number;
}

interface SensitivePattern {
  category: string;
  pattern: RegExp;
}

/**
 * 敏感项模式（顺序 = 遮蔽时的替换优先级；私钥头先于密钥赋值形态，
 * 避免 `-----BEGIN ... PRIVATE KEY-----` 块先被密钥模式啃掉一角）。
 */
export const SENSITIVE_SCAN_PATTERNS: readonly SensitivePattern[] = [
  { category: 'flag', pattern: /flag\{[^}\r\n]{0,200}\}/gi },
  { category: '私钥', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g },
  { category: 'API key', pattern: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { category: '密钥', pattern: /(?:api[_-]?key|token|secret)["']?\s*[:=]\s*["']?[A-Za-z0-9_\-+/=]{20,}/gi },
  { category: '内网 IP', pattern: /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))(?:\.\d{1,3}){2}\b/g },
];

/** 扫全文，按类别计数（只报命中的类别，顺序照 SENSITIVE_SCAN_PATTERNS）。 */
export function scanSensitiveHits(text: string): SensitiveHit[] {
  const hits: SensitiveHit[] = [];
  for (const { category, pattern } of SENSITIVE_SCAN_PATTERNS) {
    const count = [...text.matchAll(pattern)].length;
    if (count > 0) hits.push({ category, count });
  }
  return hits;
}

/** 批准模态里的一行计数：「flag×1 密钥×2 内网 IP×3」；无命中 → '无'。 */
export function formatSensitiveSummary(hits: SensitiveHit[]): string {
  if (hits.length === 0) return '无';
  return hits.map((h) => `${h.category}×${h.count}`).join(' ');
}

/**
 * 逐命中遮蔽为 `[redacted:类别]`。多模式重叠命中时先匹配的模式赢
 * （顺序即优先级）；返回遮蔽后文本与计数（计数基于遮蔽前原文，
 * 与批准模态给人看的数字一致——先计数后遮蔽，数字不漂移）。
 */
export function sanitizeSensitiveText(text: string): { text: string; hits: SensitiveHit[] } {
  const hits = scanSensitiveHits(text);
  let out = text;
  for (const { category, pattern } of SENSITIVE_SCAN_PATTERNS) {
    out = out.replace(pattern, `[redacted:${category}]`);
  }
  return { text: out, hits };
}
