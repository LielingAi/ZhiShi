/**
 * Regression test for issue #239 — `cc-plugin install file://…` of a plugin
 * that ALREADY lives in ~/.zhishi/plugins/<name> used to 409 with
 * "目录已存在" and never register, so `cc-plugin list` showed nothing while
 * the dir sat on disk.
 *
 * Root cause: source path == install path for a local file:// source, so the
 * staging→rename flow tripped its own `existsSync(installPath)` guard. Fix:
 * detect source-is-target and register the directory in place.
 *
 * Stateful (touches real fs + config.json lock + module-level installingNames),
 * so it lives in the serial `stateful` pool, not the fast unit pool.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installPlugin, listInstalledPlugins, pathsEqual } from '../plugins/store';

describe('plugin install — register-in-place (#239)', () => {
  let home: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'zhishi-plugin-inplace-'));
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    // getHomeDirOrNull() reads HOME (unix) / USERPROFILE (win) at call time.
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const zhishi = join(home, '.zhishi');
    mkdirSync(zhishi, { recursive: true });
    // Seed an empty config so withConfigLock has a file to lock + rewrite.
    writeFileSync(join(zhishi, 'config.json'), JSON.stringify({}, null, 2), 'utf-8');
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserProfile;
    rmSync(home, { recursive: true, force: true });
  });

  it('registers a valid plugin dir that already sits in plugins/<name> instead of 409ing', async () => {
    // User manually created ~/.zhishi/plugins/test-echo with a valid layout.
    const pluginDir = join(home, '.zhishi', 'plugins', 'test-echo');
    mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true });
    mkdirSync(join(pluginDir, 'commands'), { recursive: true });
    writeFileSync(
      join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'test-echo', version: '0.1.0' }, null, 2),
      'utf-8',
    );
    writeFileSync(join(pluginDir, 'commands', 'hello.md'), '# hello\n', 'utf-8');

    const fileUrl = pathToFileURL(pluginDir).href;

    // Before the fix this rejected with PluginStoreError TARGET_EXISTS (409).
    const report = await installPlugin(fileUrl);

    expect(report.entry.name).toBe('test-echo');
    expect(report.entry.source).toBe('local');
    // Registered in place — installPath unchanged, dir untouched on disk.
    expect(pathsEqual(report.entry.installPath, pluginDir)).toBe(true);
    expect(existsSync(join(pluginDir, '.claude-plugin', 'plugin.json'))).toBe(true);

    // And now it shows up in `cc-plugin list`.
    const listed = listInstalledPlugins();
    expect(listed.some((p) => p.name === 'test-echo')).toBe(true);
  });

  it('still 409s a name collision when the source is OUTSIDE plugins/ (orphan dir)', async () => {
    // A pre-existing (unrelated) dir occupies plugins/foo …
    const occupied = join(home, '.zhishi', 'plugins', 'foo');
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, 'stray.txt'), 'not a plugin', 'utf-8');

    // … and we try to install a *different* foo plugin from elsewhere on disk.
    const external = join(home, 'elsewhere', 'foo');
    mkdirSync(join(external, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(external, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'foo', version: '1.0.0' }, null, 2),
      'utf-8',
    );

    await expect(installPlugin(pathToFileURL(external).href)).rejects.toMatchObject({
      code: 'TARGET_EXISTS',
      statusCode: 409,
    });
  });

  it('rolls back the moved dir when the config commit fails (W4 — no orphan)', () => {
    // External source (rename path, not in-place).
    const external = join(home, 'elsewhere', 'rollback-plugin');
    mkdirSync(join(external, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(external, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'rollback-plugin', version: '1.0.0' }, null, 2),
      'utf-8',
    );

    // Force the config commit to fail AFTER the staging→install rename:
    // replace config.json with a (non-empty) DIRECTORY so withConfigLock's final
    // renameSync(config.json.tmp → config.json) throws.
    const configPath = join(home, '.zhishi', 'config.json');
    rmSync(configPath, { force: true });
    mkdirSync(configPath, { recursive: true });
    writeFileSync(join(configPath, 'block'), 'x', 'utf-8');

    const installPath = join(home, '.zhishi', 'plugins', 'rollback-plugin');
    return expect(installPlugin(pathToFileURL(external).href)).rejects.toBeTruthy().then(() => {
      // The half-finished dir must be rolled back — not left as an orphan that
      // would 409 every future install of the same name.
      expect(existsSync(installPath)).toBe(false);
    });
  });
});

describe('pathsEqual (#239 helper)', () => {
  it('matches paths that differ only by . / .. / trailing slash', () => {
    expect(pathsEqual('/a/b', '/a/./b')).toBe(true);
    expect(pathsEqual('/a/b/', '/a/b')).toBe(true);
    expect(pathsEqual('/a/b/../b', '/a/b')).toBe(true);
  });
  it('distinguishes genuinely different paths', () => {
    expect(pathsEqual('/a/b', '/a/c')).toBe(false);
  });
});
