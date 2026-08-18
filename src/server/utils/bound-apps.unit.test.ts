// Unit tests for AppCraft bound-apps resolution (PRD 0.2.36 §6.1).
//
// Follows the scratch-HOME pattern of __tests__/workspace-config-permission.test.ts:
// getZhiShiDataDir() resolves from HOME/USERPROFILE, so pointing those at a
// temp dir isolates projects.json per test.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getEnabledBoundAppsForWorkspace, getEnabledBoundAppDataDirs } from './bound-apps';
import { buildBoundAppsSection } from '../system-prompt';
import type { BoundApp } from '../../shared/config-types';

let scratch: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let prevDataDir: string | undefined;

function writeProjects(projects: Array<Record<string, unknown>>): void {
  writeFileSync(
    join(scratch, '.zhishi', 'projects.json'),
    JSON.stringify(projects, null, 2),
    'utf-8',
  );
}

const kingdee: BoundApp = {
  id: 'kingdee',
  name: '金蝶财务',
  exe: 'C:/Kingdee/kd.exe',
  windowTitle: '金蝶KIS*',
  launchArgs: '--company=默认账套',
  dataDir: 'D:/账套导出',
  enabled: true,
};

const wecomDisabled: BoundApp = {
  id: 'wecom',
  name: '企业微信',
  exe: 'C:/WeCom/wxwork.exe',
  windowTitle: '企业微信',
  enabled: false,
};

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'zhishi-bound-apps-'));
  mkdirSync(join(scratch, '.zhishi'), { recursive: true });
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  prevDataDir = process.env.ZHISHI_DATA_DIR;
  process.env.HOME = scratch;
  process.env.USERPROFILE = scratch;
  delete process.env.ZHISHI_DATA_DIR;
});

afterEach(() => {
  process.env.HOME = prevHome;
  process.env.USERPROFILE = prevUserProfile;
  if (prevDataDir === undefined) delete process.env.ZHISHI_DATA_DIR;
  else process.env.ZHISHI_DATA_DIR = prevDataDir;
  rmSync(scratch, { recursive: true, force: true });
});

describe('getEnabledBoundAppsForWorkspace', () => {
  it('returns [] when projects.json does not exist', () => {
    expect(getEnabledBoundAppsForWorkspace('E:/code/u-disk')).toEqual([]);
  });

  it('returns [] for empty workspace path (Global sidecar)', () => {
    expect(getEnabledBoundAppsForWorkspace('')).toEqual([]);
  });

  it('returns [] when the workspace has no matching project', () => {
    writeProjects([{ id: 'p1', name: 'other', path: 'C:/other', boundApps: [kingdee] }]);
    expect(getEnabledBoundAppsForWorkspace('E:/code/u-disk')).toEqual([]);
  });

  it('returns only enabled apps for the matching project', () => {
    writeProjects([{ id: 'p1', name: 'ws', path: 'E:/code/u-disk', boundApps: [kingdee, wecomDisabled] }]);
    expect(getEnabledBoundAppsForWorkspace('E:/code/u-disk')).toEqual([kingdee]);
  });

  it('matches workspace identity across separator/case forms (#320 class)', () => {
    writeProjects([{ id: 'p1', name: 'ws', path: 'E:\\code\\u-disk\\', boundApps: [kingdee] }]);
    expect(getEnabledBoundAppsForWorkspace('e:/code/u-disk')).toEqual([kingdee]);
  });

  it('drops malformed entries from user-edited projects.json', () => {
    writeProjects([{
      id: 'p1',
      name: 'ws',
      path: 'E:/code/u-disk',
      boundApps: [kingdee, { id: 'broken' }, null, 'garbage'],
    }]);
    expect(getEnabledBoundAppsForWorkspace('E:/code/u-disk')).toEqual([kingdee]);
  });
});

describe('getEnabledBoundAppDataDirs', () => {
  it('collects dataDirs of enabled apps only, skipping missing ones', () => {
    const noDataDir: BoundApp = { id: 'x', name: 'X', exe: 'C:/x/x.exe', windowTitle: 'X*', enabled: true };
    writeProjects([{ id: 'p1', name: 'ws', path: 'E:/code/u-disk', boundApps: [kingdee, noDataDir, wecomDisabled] }]);
    expect(getEnabledBoundAppDataDirs('E:/code/u-disk')).toEqual(['D:/账套导出']);
  });

  it('returns [] when nothing is bound', () => {
    expect(getEnabledBoundAppDataDirs('E:/code/u-disk')).toEqual([]);
  });
});

describe('buildBoundAppsSection', () => {
  it('returns empty string for undefined/empty input (zero injection)', () => {
    expect(buildBoundAppsSection(undefined)).toBe('');
    expect(buildBoundAppsSection([])).toBe('');
  });

  it('renders the app manifest and cuse guidance', () => {
    const section = buildBoundAppsSection([kingdee]);
    expect(section).toContain('<zhishi-bound-apps>');
    expect(section).toContain('</zhishi-bound-apps>');
    expect(section).toContain('金蝶财务');
    expect(section).toContain('C:/Kingdee/kd.exe');
    expect(section).toContain('金蝶KIS*');
    expect(section).toContain('D:/账套导出');
    expect(section).toContain('cuse');
    expect(section).toContain('窗口');
  });

  it('omits the dataDir line fragment when an app has no dataDir', () => {
    const app: BoundApp = { id: 'x', name: 'X', exe: 'C:/x/x.exe', windowTitle: 'X*', enabled: true };
    const section = buildBoundAppsSection([app]);
    expect(section).not.toContain('数据目录:');
  });
});
