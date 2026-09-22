import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { scanRecipes, aggregateRecipeTools } from './recipes';

// 守卫测试：bundled-environments/ 里的出厂配方必须全部可解析、合法。
// 防止配方 frontmatter 写坏/缺文件混进发布包（解析器对单配方容错，错误会静默降级为 invalid）。
const BUNDLED_ROOT = resolve(process.cwd(), 'bundled-environments');

describe('bundled environment recipes（出厂配方守卫）', () => {
  const recipes = scanRecipes(BUNDLED_ROOT);

  it('dev / pwn / fuzz / rev / pwn-vm / pwn-win / fuzz-vm / code-audit / pentest / pentest-vm / ai-security / office-lab / browser-lab / win-kernel 十四个配方齐备', () => {
    expect(recipes.map((r) => r.id).sort()).toEqual(['ai-security', 'browser-lab', 'code-audit', 'dev', 'fuzz', 'fuzz-vm', 'office-lab', 'pentest', 'pentest-vm', 'pwn', 'pwn-vm', 'pwn-win', 'rev', 'win-kernel']);
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

  it('pwn-win（1.6.4）：os_family=windows + setup.ps1 在场 + 快照相机', () => {
    const pwnWin = recipes.find((r) => r.id === 'pwn-win');
    expect(pwnWin?.base).toBe('vm');
    expect(pwnWin?.osFamily).toBe('windows');
    expect(pwnWin?.vmUser).toBeTruthy();
    expect(pwnWin?.vmSnapshot).toBe('zhishi-clean');
    // validateRecipe 已保证 setup.ps1 在场（否则 invalid，上面全 valid 用例会炸）；
    // 这里再直接读盘守一次（防 validate 规则被改坏）。
    const ps1 = join(BUNDLED_ROOT, 'pwn-win', 'setup.ps1');
    expect(existsSync(ps1)).toBe(true);
    // UTF-8 BOM 守卫：PS 5.1 对无 BOM 的 .ps1 按 ANSI 读，中文注释乱码炸解析
    // （1.6.4 实机抓出；编辑器/工具链改写文件时 BOM 容易丢）。
    const head = readFileSync(ps1).subarray(0, 3);
    expect([...head]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('Windows 研究配方族（1.8.0）：office-lab / browser-lab / win-kernel 同 pwn-win 纪律', () => {
    for (const id of ['office-lab', 'browser-lab', 'win-kernel']) {
      const r = recipes.find((x) => x.id === id);
      expect(r?.base, id).toBe('vm');
      expect(r?.osFamily, id).toBe('windows');
      expect(r?.vmUser, id).toBeTruthy();
      expect(r?.vmSnapshot, id).toBe('zhishi-clean');
      // setup.ps1 在场 + UTF-8 BOM（PS 5.1 无 BOM 按 ANSI 读，中文注释炸解析）
      const ps1 = join(BUNDLED_ROOT, id, 'setup.ps1');
      expect(existsSync(ps1), id).toBe(true);
      const head = readFileSync(ps1).subarray(0, 3);
      expect([...head], `${id} setup.ps1 BOM`).toEqual([0xef, 0xbb, 0xbf]);
    }
  });

  it('win-kernel（1.8.0）：debug 段解析——pipe 管道名进 EnvironmentRecipe', () => {
    const winKernel = recipes.find((r) => r.id === 'win-kernel');
    expect(winKernel?.debug).toEqual({ transport: 'pipe', pipe: 'kd_win-kernel' });
    // tools[] 与探测映射一致（verifier/wdk 等映射词在 TOOL_PROBE_COMMANDS 有词）
    expect(winKernel?.tools).toEqual(['wdk', 'windbg', 'osr-loader', 'verifier']);
    expect(winKernel?.firstRunTools).toEqual(['wdk']);
  });

  it('office-lab / browser-lab（1.8.0）：tools[] 与探测映射词一致', () => {
    const officeLab = recipes.find((r) => r.id === 'office-lab');
    expect(officeLab?.tools).toEqual(['python', 'oletools', 'sysinternals', 'cdb', 'office-2019']);
    expect(officeLab?.firstRunTools).toEqual(['office-2019']);
    const browserLab = recipes.find((r) => r.id === 'browser-lab');
    expect(browserLab?.tools).toEqual(['python', 'sysinternals', 'cdb', 'chrome-old']);
    expect(browserLab?.firstRunTools).toEqual(['chrome-old']);
  });

  it('关键工具聚合可达（gdb/ROPgadget/afl-fuzz/clang——均为真实二进制名，toolCheck 依赖）', () => {
    const tools = new Set(aggregateRecipeTools(recipes).map((t) => t.tool));
    for (const t of ['gdb', 'clang', 'afl-fuzz', 'ROPgadget']) {
      expect(tools.has(t), `tool ${t}`).toBe(true);
    }
  });
});
