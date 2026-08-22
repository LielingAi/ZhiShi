import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { scanRecipes, aggregateRecipeTools } from './recipes';

// 守卫测试：bundled-environments/ 里的出厂配方必须全部可解析、合法。
// 防止配方 frontmatter 写坏/缺文件混进发布包（解析器对单配方容错，错误会静默降级为 invalid）。
const BUNDLED_ROOT = resolve(process.cwd(), 'bundled-environments');

describe('bundled environment recipes（出厂配方守卫）', () => {
  const recipes = scanRecipes(BUNDLED_ROOT);

  it('dev / pwn / fuzz / rev / pwn-vm / fuzz-vm / code-audit / pentest / pentest-vm / ai-security 十个配方齐备', () => {
    expect(recipes.map((r) => r.id).sort()).toEqual(['ai-security', 'code-audit', 'dev', 'fuzz', 'fuzz-vm', 'pentest', 'pentest-vm', 'pwn', 'pwn-vm', 'rev']);
  });

  it('全部 valid（无 invalidReasons）', () => {
    for (const r of recipes) {
      expect(r.invalidReasons, `recipe ${r.id}: ${r.invalidReasons.join('; ')}`).toEqual([]);
      expect(r.valid).toBe(true);
    }
  });

  it('每个配方声明合法 base + 非空工具清单 + description', () => {
    for (const r of recipes) {
      expect(['docker', 'vm'], r.id).toContain(r.base);
      expect(r.tools.length, r.id).toBeGreaterThan(0);
      expect(r.description && r.description.length > 10, r.id).toBe(true);
    }
  });

  it('docker 配方带 Dockerfile；vm 配方声明快照约定（无 Dockerfile）', () => {
    for (const r of recipes) {
      if (r.base === 'vm') {
        expect(r.vmSnapshot, r.id).toBeTruthy();
      }
    }
    const pwnVm = recipes.find((r) => r.id === 'pwn-vm');
    expect(pwnVm?.base).toBe('vm');
    expect(pwnVm?.vmUser).toBeTruthy();
  });

  it('关键工具聚合可达（gdb/ROPgadget/afl-fuzz/clang——均为真实二进制名，toolCheck 依赖）', () => {
    const tools = new Set(aggregateRecipeTools(recipes).map((t) => t.tool));
    for (const t of ['gdb', 'clang', 'afl-fuzz', 'ROPgadget']) {
      expect(tools.has(t), `tool ${t}`).toBe(true);
    }
  });
});
