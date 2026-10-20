/**
 * secrets-env（utils/secrets-env.ts）unit tests。
 *
 * 纯逻辑 + 临时目录真文件加载；加载用例全程用 zhishi_test_ 前缀的独有
 * 变量名，不碰真实环境变量；进程环境 set/delete 前后自净。
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadSecretsEnv, parseSecretsEnv, SECRETS_ENV_FILE } from './secrets-env';

const touched: string[] = [];

afterEach(() => {
  for (const key of touched.splice(0)) delete process.env[key];
});

describe('parseSecretsEnv', () => {
  it('KEY=VALUE / 注释 / 空行 / export 前缀 / 引号剥离', () => {
    const parsed = parseSecretsEnv(
      [
        '# 注释行',
        '',
        'CAM01_PW=xxxx',
        'export SWITCH_PW=yyyy',
        'QUOTED="zz zz"',
        "SQUOTED='a=b'",
      ].join('\n'),
    );
    expect(parsed).toEqual({
      CAM01_PW: 'xxxx',
      SWITCH_PW: 'yyyy',
      QUOTED: 'zz zz',
      SQUOTED: 'a=b',
    });
  });

  it('非法行跳过（无 = / 空 key / 非法变量名 / = 在行首）', () => {
    const parsed = parseSecretsEnv('GOOD=1\nNO_EQUALS\n1BAD=2\n=3\n  = 4');
    expect(parsed).toEqual({ GOOD: '1' });
  });

  it('值里带 = 保留；值内空格保留（不剥引号时）', () => {
    const parsed = parseSecretsEnv('A=a=b=c\nB=  raw value  ');
    expect(parsed.A).toBe('a=b=c');
    expect(parsed.B).toBe('raw value');
  });
});

describe('loadSecretsEnv', () => {
  it('缺文件 → 0，零副作用', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zhishi-secrets-'));
    try {
      expect(loadSecretsEnv(dir)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('加载进进程环境；已存在的同名变量不覆盖', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zhishi-secrets-'));
    try {
      writeFileSync(join(dir, SECRETS_ENV_FILE), 'zhishi_test_a=from-file\nzhishi_test_b=kept\n');
      process.env.zhishi_test_b = 'pre-existing';
      touched.push('zhishi_test_a', 'zhishi_test_b');
      const loaded = loadSecretsEnv(dir);
      expect(loaded).toBe(1);
      expect(process.env.zhishi_test_a).toBe('from-file');
      expect(process.env.zhishi_test_b).toBe('pre-existing');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('读取失败走 onWarn，返回 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zhishi-secrets-'));
    const warnings: string[] = [];
    try {
      // 造一个同名目录（readFileSync 对目录报 EISDIR → 走 onWarn 分支）。
      mkdirSync(join(dir, SECRETS_ENV_FILE));
      expect(existsSync(join(dir, SECRETS_ENV_FILE))).toBe(true);
      expect(loadSecretsEnv(dir, (m) => warnings.push(m))).toBe(0);
      expect(warnings.some((m) => m.includes('读取失败'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
