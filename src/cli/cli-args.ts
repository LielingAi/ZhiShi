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
  // 可重复旗标：重复出现时累积成数组。1.5.4 审计收敛：args/headers/var 随
  // MCP 删除退役（全仓零消费方）；env 移出（term open --env 重复传曾静默
  // 拼成 'a,b' 非法 envTag，审计 A3-6）——--env 现在是普通 key-value 旗标，
  // 重复传时后者覆盖前者。
  const repeatable = new Set(['models', 'model-names']);
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
      // value when it doesn't start with `--`（presence-only 旗标漏登记会把
      // 下一个位置参数吞成旗标值）。
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
      // starts with '--' (e.g. --models "--foo"). The boolean-fallback check
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
    } else {
      // 裸 `-x` 短旗标无消费方（-p→prompt 已于 1.5.4 随零引用删除）——
      // 一律按位置参数处理。
      positional.push(arg);
      i++;
    }
  }
  return { positional, flags };
}

/**
 * 全局 --port 旗标是否覆盖 sidecar 端口。
 * 例外：`env add --kind ssh --port N` 的 --port 是目标主机端口（进请求体），
 * 不是 sidecar 端口——1.5.4 审计 A1-4：全局覆盖曾在路由分发前无条件套用，
 * 文档化的 ssh --port 用法会把 2222 误当 sidecar 端口、必然 ECONNREFUSED。
 */
export function isSidecarPortOverride(positional: string[]): boolean {
  return !(positional[0] === 'env' && positional[1] === 'add');
}
