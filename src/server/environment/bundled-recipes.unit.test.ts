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
    // 1.9.4：guest 工具面**不声明宿主侧工具**——WinDbg 是双机调试的 client，
    // 跑在宿主（本机条目），guest 里永远没有它；声明它会换来一条必然的
    // 「声明了但环境里没有：windbg」，把模型导向去 guest 里装 WinDbg。
    // 宿主侧可用性由本机工具链面（LOCAL_TOOLCHAIN_PROBE）负责。
    expect(winKernel?.tools).toEqual(['wdk', 'osr-loader', 'verifier']);
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

// ===== 1.9.3：配方安装脚本的容错纪律 =====
//
// 2026-10-02 实证（PyPI 官方索引 + 上游 README 核实）：pentest 的 setup.sh 用**一条**
// pip 命令装 netexec + enum4linux-ng + impacket + graphql-cop + playwright —— 前两个在
// PyPI 上不存在（404）、graphql-cop 被 quarantine（simple 索引 200 但文件列表为空），
// pip 在解析阶段整体失败：一个包都不装，连本来能装的 impacket / playwright 也被拖死。
// pentest-vm 更重：那条链的最后一档没有兜底，在 `set -e` 下直接非空退出，其后的
// SecLists / nuclei / katana / subfinder / httpx / arjun / ZAP / playwright 全不执行。
//
// 这两条守卫锁住纪律，别让同类回归再靠「实机踩一次」发现。

describe('配方 setup.sh 安装纪律（1.9.3）', () => {
  const recipes = scanRecipes(BUNDLED_ROOT);
  const setupIds = recipes.map((r) => r.id).filter((id) => existsSync(join(BUNDLED_ROOT, id, 'setup.sh')));
  const setupOf = (id: string) => readFileSync(join(BUNDLED_ROOT, id, 'setup.sh'), 'utf-8');
  /** 反斜杠续行先拼成一行——兜底可能写在续行的下一行，逐行看会误判。 */
  const logicalLines = (src: string) => src.replace(/\\\r?\n/g, ' ').split('\n');
  const pipInstallLines = (src: string) =>
    logicalLines(src).filter((l) => /^\s*pip3?\s+install/.test(l));
  /** 去掉双引号串：WARN 文案里会写工具名，不该被当成包名。 */
  const stripQuoted = (l: string) => l.replace(/"[^"]*"/g, '""');

  it('每个 pip 安装链都有兜底（链尾必须降到 WARN/true——否则 set -e 会中止整个脚本）', () => {
    expect(setupIds.length).toBeGreaterThan(5); // 守卫本身别被空集合骗过
    for (const id of setupIds) {
      for (const line of pipInstallLines(setupOf(id))) {
        // 链里必须出现 `|| echo …`（WARN 降级）或 `|| true`。只写 `A || B || C`
        // 而 C 仍是 pip 不算兜底——2026-10-02 pentest-vm 就是这么整段中止的：
        // 其后 SecLists/nuclei/katana/subfinder/httpx/arjun/ZAP/playwright 全不执行。
        expect(line, `${id}/setup.sh 的 pip 链没有兜底：${line.trim().slice(0, 90)}`)
          .toMatch(/\|\|\s*(echo|true)\b/);
      }
    }
  });

  it('已知无 PyPI 分发的工具不得当 PyPI 包名装（netexec / enum4linux-ng / graphql-cop）', () => {
    const NO_PYPI_PACKAGE = ['netexec', 'enum4linux-ng', 'graphql-cop'];
    for (const id of setupIds) {
      for (const line of pipInstallLines(setupOf(id))) {
        const bare = stripQuoted(line); // 判据看正文（引号里的 WARN 文案不算）
        const hasGitUrl = line.includes('git+');
        for (const bad of NO_PYPI_PACKAGE) {
          // 允许出现在路径或 git URL 里（/opt/graphql-cop/requirements.txt、
          // git+…/NetExec），只禁止「裸包名」形态（前后是空白或行界）。
          const barePkg = new RegExp(`(^|\\s)${bad}(\\s|$)`).test(bare) && !hasGitUrl;
          expect(barePkg, `${id}/setup.sh 把 ${bad} 当 PyPI 包名装`).toBe(false);
        }
      }
    }
  });

  it('无 PyPI 分发的工具必须走上游通道（pipx git+ / git clone + 包装脚本）', () => {
    const pentest = setupOf('pentest');
    expect(pentest).toContain('git+https://github.com/Pennyw0rth/NetExec'); // 官方 pipx 通道
    expect(pentest).toContain('github.com/cddmp/enum4linux-ng');
    expect(pentest).toContain('github.com/dolevf/graphql-cop');
    expect(pentest).toContain('wrap_py_tool enum4linux-ng'); // 脚本名 → 配方声明的命令名
    expect(pentest).toContain('wrap_py_tool graphql-cop');
    expect(setupOf('pentest-vm')).toContain('git+https://github.com/Pennyw0rth/NetExec');
  });
});
