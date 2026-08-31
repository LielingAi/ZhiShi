import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// 1.5.4 审计 A3-7 / A3-8 回归钉：
//  - sync-version.js：Cargo.toml / constants.ts 正则失配必须报错退出（不得静默 ✓）
//  - smoke.mjs：--only 缺值必须报错退出（不得静默跑全量）
// sync-version 用临时目录密封运行（脚本按自身位置推 rootDir），不碰真实发版文件。

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

let work: string;

function runNode(scriptPath: string, args: string[]) {
  return spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf-8' });
}

/** 在临时目录搭一个最小可运行的 sync-version 现场，返回脚本路径。 */
function seedSyncVersionFixture(overrides: { cargo?: string; constants?: string } = {}) {
  const dir = join(work, `fixture-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'src-tauri'), { recursive: true });
  mkdirSync(join(dir, 'src/shared'), { recursive: true });
  cpSync(join(REPO_ROOT, 'scripts/sync-version.js'), join(dir, 'scripts/sync-version.js'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module', version: '9.9.9' }));
  writeFileSync(join(dir, 'src-tauri/tauri.conf.json'), JSON.stringify({ version: '0.0.0' }) + '\n');
  writeFileSync(
    join(dir, 'src-tauri/Cargo.toml'),
    overrides.cargo ?? '[package]\nname = "zhishi"\nversion = "0.0.0"\n',
  );
  writeFileSync(
    join(dir, 'src/shared/constants.ts'),
    overrides.constants ?? "export const GUI_VERSION = '0.0.0';\n",
  );
  return { script: join(dir, 'scripts/sync-version.js'), dir };
}

beforeEach(() => {
  work = join(tmpdir(), `zhishi-scripts-test-${process.pid}`);
  mkdirSync(work, { recursive: true });
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('sync-version.js — 正则替换失配校验（A3-7）', () => {
  it('正常形态：三个目标全部替换为新版本', () => {
    const { script, dir } = seedSyncVersionFixture();
    const r = runNode(script, []);
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, 'src-tauri/Cargo.toml'), 'utf-8')).toContain('version = "9.9.9"');
    expect(readFileSync(join(dir, 'src/shared/constants.ts'), 'utf-8')).toContain("GUI_VERSION = '9.9.9'");
    expect(JSON.parse(readFileSync(join(dir, 'src-tauri/tauri.conf.json'), 'utf-8')).version).toBe('9.9.9');
  });

  it('Cargo.toml 版本行失配 → exit 1 且不写文件', () => {
    const { script, dir } = seedSyncVersionFixture({ cargo: '[package]\nname = "zhishi"\n' });
    const r = runNode(script, []);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Cargo.toml');
    expect(readFileSync(join(dir, 'src-tauri/Cargo.toml'), 'utf-8')).toBe('[package]\nname = "zhishi"\n');
  });

  it('constants.ts GUI_VERSION 失配 → exit 1 且不写文件', () => {
    const { script, dir } = seedSyncVersionFixture({ constants: 'export const GUI_VERSION = "0.0.0";\n' });
    const r = runNode(script, []);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('constants.ts');
    expect(readFileSync(join(dir, 'src/shared/constants.ts'), 'utf-8')).toBe('export const GUI_VERSION = "0.0.0";\n');
  });
});

describe('smoke.mjs — --only 缺值报错（A3-8）', () => {
  const SMOKE = join(REPO_ROOT, 'scripts/smoke.mjs');

  it('--only 后无值 → exit 2 且不跑任何套件', () => {
    const r = runNode(SMOKE, ['--only']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--only 需要一个套件名参数');
  });

  it('--only= 空值 → exit 2', () => {
    const r = runNode(SMOKE, ['--only=']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('需要一个套件名参数');
  });

  it('-o 后随另一旗标 → 视为缺值 exit 2', () => {
    const r = runNode(SMOKE, ['-o', '--only=m1-smoke']);
    expect(r.status).toBe(2);
  });

  it('未知套件名 → exit 2（原有语义保持）', () => {
    const r = runNode(SMOKE, ['--only', 'no-such-suite']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('未知脚本');
  });
});
