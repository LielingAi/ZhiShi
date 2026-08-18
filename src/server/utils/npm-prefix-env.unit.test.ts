import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import {
  getZhiShiNpmGlobalBinDir,
  getZhiShiNpmGlobalPrefix,
  scrubZhiShiNpmPrefixEnv,
} from './npm-prefix-env';

describe('npm prefix env utilities', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('builds the ZhiShi npm global prefix and bin dir per platform', () => {
    process.env.ZHISHI_DATA_DIR = '/Users/tester/.zhishi';
    expect(getZhiShiNpmGlobalPrefix('darwin')).toBe('/Users/tester/.zhishi/npm-global');
    expect(getZhiShiNpmGlobalBinDir('darwin')).toBe('/Users/tester/.zhishi/npm-global/bin');

    process.env.ZHISHI_DATA_DIR = 'C:\\Users\\tester\\.zhishi';
    expect(getZhiShiNpmGlobalPrefix('win32')).toMatch(/C:[/\\]Users[/\\]tester[/\\]\.zhishi[/\\]npm-global/);
    expect(getZhiShiNpmGlobalBinDir('win32')).toMatch(/C:[/\\]Users[/\\]tester[/\\]\.zhishi[/\\]npm-global/);
  });

  it('scrubs only npm prefix variables that point at the ZhiShi prefix', () => {
    const prefix = '/Users/tester/.zhishi/npm-global';
    const env: NodeJS.ProcessEnv = {
      npm_config_prefix: `${prefix}/`,
      NPM_CONFIG_PREFIX: '/Users/tester/.npm-global',
      PREFIX: prefix,
    };

    scrubZhiShiNpmPrefixEnv(env, prefix, 'darwin');

    expect(env.npm_config_prefix).toBeUndefined();
    expect(env.NPM_CONFIG_PREFIX).toBe('/Users/tester/.npm-global');
    expect(env.PREFIX).toBeUndefined();
  });
});
