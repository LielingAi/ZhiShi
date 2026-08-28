/**
 * 1.4.7 — CLI 参数解析纯函数（从 zhishi.ts 抽离，zhishi.ts 主体单测起步的
 * 第一步）：parseArgs + camelCase 是 CLI 的边界解析层——无 IO、无
 * process.exit，可纯单测。zhishi.ts 从本模块导入，行为零变化。
 */

/** kebab-case → camelCase（`--task-id` → taskId）。 */
export function camelCase(s: string): string {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/** Parse CLI arguments into structured flags and positional args */
export function parseArgs(args: string[]): { positional: string[]; flags: Record<string, unknown> } {
  const positional: string[] = [];
  const flags: Record<string, unknown> = {};
  const repeatable = new Set(['args', 'env', 'headers', 'models', 'model-names', 'var']);
// Short-flag → long-flag mapping. Only specific aliases are mapped; bare `-` prefixed positional
  // args remain valid (none of the current commands actually use bare-`-`
  // positional, but the explicit allow-list keeps the door open if needed).
  const shortFlagAliases: Record<string, string> = {
    'p': 'prompt',
    // Add more here if PRD documents additional short flags.
  };
let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      // Support both `--key value` and `--key=value` forms. The equals form
      // is ubiquitous in GNU-style CLIs; without it, callers (especially AI
      // agents) get silently-dropped values + confusing "missing flag" errors
      // downstream.
      const raw = arg.slice(2);
      const eq = raw.indexOf('=');
      const key = eq >= 0 ? raw.slice(0, eq) : raw;
      const inlineValue = eq >= 0 ? raw.slice(eq + 1) : undefined;
      // Boolean flags (no value follows). Missing entries trigger the
      // generic key-value branch below — which consumes the NEXT token as
      // value when it doesn't start with `--`. That silently eats short
      // flags like `-p` (a presence-only flag followed by `-p` would otherwise
      // swallow `-p` as its value and drop the prompt).
      // Add any new presence-only flag here.
      if (
        key === 'help' ||
        key === 'json' ||
        key === 'dry-run' ||
        key === 'disable-nonessential' ||
        key === 'full' ||
        key === 'clear-provider-override' ||
        key === 'new-dek' ||
        // 2026-08-06 审计 F-12：presence-only flag 必须在此清单里，
        // 否则 `--force myskill` 会把 myskill 吞成 flag 值、positional 丢失。
        // ('yes-high-risk' 已随 1.2.3 AppCraft 退役移除)
        key === 'force' ||
        key === 'purge-data' ||
        key === 'include-deleted' ||
        key === 'run'
      ) {
        flags[camelCase(key)] = true;
        i++;
        continue;
      }
      // Repeatable flags: ALWAYS consume the next token as a value, even if it
      // starts with '--' (e.g. --args "--stdio"). The boolean-fallback check
      // below must NOT run for repeatable flags — it would overwrite the
      // accumulated array with `true`.
      if (repeatable.has(key)) {
        const cKey = camelCase(key);
        const arr = (flags[cKey] as string[]) || [];
        if (inlineValue !== undefined) {
          arr.push(inlineValue);
          flags[cKey] = arr;
          i++;
          continue;
        }
        const value = args[i + 1];
        if (value === undefined) {
          // No value — normalize to empty array (not boolean) to keep type consistent
          if (!flags[cKey]) flags[cKey] = [];
          i++;
          continue;
        }
        arr.push(value);
        flags[cKey] = arr;
        i += 2;
        continue;
      }
      // Key-value flags (non-repeatable)
      if (inlineValue !== undefined) {
        flags[camelCase(key)] = inlineValue;
        i++;
        continue;
      }
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        flags[camelCase(key)] = true;
        i++;
        continue;
      }
      flags[camelCase(key)] = value;
      i += 2;
    } else if (arg.length === 2 && arg.startsWith('-') && shortFlagAliases[arg.slice(1)]) {
      // Short flag (e.g. -p) maps to long flag (--prompt). Always consumes the
      // next token as value (or treats as boolean if next is missing/another flag).
      const longKey = shortFlagAliases[arg.slice(1)]!;
      const value = args[i + 1];
      if (value === undefined || value.startsWith('-')) {
        flags[camelCase(longKey)] = true;
        i++;
      } else {
        flags[camelCase(longKey)] = value;
        i += 2;
      }
    } else {
      positional.push(arg);
      i++;
    }
  }
  return { positional, flags };
}
