/**
 * signal-extract (plan §2.3, design §4 附加律引擎)——**域包清单驱动**。
 *
 * 规则来源(2026-08-17 数据化):
 *   1. 域清单 bundled-domains/<域>/domain.json 的 signals(域自有,优先);
 *   2. 内置跨域通用规则(exit 码/CVE/端口/凭据命中——不属于任何单一域)。
 * 域自有信号(崩溃/flag/core dump)已从硬编码迁入 binary 清单——加一个域
 * 的信号不再改引擎。
 *
 * 每条规则:输出命中 re → 摘要行给 label(+可选 appendMatch 附匹配本体)。
 * 同文本去重(清单与内置撞同一命中时只留一份)。每规则一条单测。
 */

import {
  collectDomainSignals,
  loadDomainManifests,
  type DomainSignalRule,
} from '../../../../server/domains/manifest';

export interface SignalHints {
  exitCode?: number;
  elapsedMs?: number;
}

// ---------------------------------------------------------------------------
// 内置跨域通用规则(不属于任何单一域的才留在这里)
// ---------------------------------------------------------------------------

const BUILTIN_GENERIC: DomainSignalRule[] = [
  { re: 'CVE-\\d{4}-\\d+', label: 'CVE 命中', appendMatch: true },
  { re: '(\\d{1,5})\\/tcp\\s+open', label: '端口开放', appendMatch: true },
  { re: '\\b(password|token|secret|api[_-]?key)\\b', label: '凭据命中' },
];

// ---------------------------------------------------------------------------
// 清单装载(进程内一次,域包不会会话中变化)
// ---------------------------------------------------------------------------

let manifestCache: DomainSignalRule[] | null = null;

/** 域清单信号(懒加载 + 缓存;测试可 reset)。 */
export function manifestSignals(): DomainSignalRule[] {
  if (manifestCache === null) {
    const loaded = collectDomainSignals(loadDomainManifests());
    manifestCache = loaded;
    return loaded;
  }
  return manifestCache;
}

/** 测试用:清缓存(改了 bundled-domains 后重读)。 */
export function resetManifestSignalsCache(): void {
  manifestCache = null;
}

// ---------------------------------------------------------------------------
// 提取
// ---------------------------------------------------------------------------

function matchRule(rule: DomainSignalRule, output: string): string | null {
  let re: RegExp;
  try {
    re = new RegExp(rule.re, 'i');
  } catch {
    return null; // 非法正则跳过(domain check 会报)
  }
  const m = output.match(re);
  if (!m) return null;
  // 有捕获组用捕获组(端口号/CVE 号/地址),否则用全匹配。
  const matched = m[1] ?? m[0];
  return rule.appendMatch ? `${rule.label} ${matched}` : rule.label;
}

/**
 * Returns a short signal string (≤ ~60 chars) or '' when nothing notable.
 * Order: exit 码(非零)→ 域清单规则 → 内置通用规则;同文本去重。
 * 凭据/flag 类只报命中不显示内容。
 */
export function extractSignal(
  toolName: string,
  output: string,
  hints: SignalHints = {},
): string {
  const signals: string[] = [];

  if (typeof hints.exitCode === 'number' && hints.exitCode !== 0) {
    signals.push(`exit=${hints.exitCode}`);
  }

  for (const rule of [...manifestSignals(), ...BUILTIN_GENERIC]) {
    const hit = matchRule(rule, output);
    if (hit && !signals.includes(hit)) signals.push(hit);
  }

  return signals.join(' · ');
}
