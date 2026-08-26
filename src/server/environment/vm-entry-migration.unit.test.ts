/**
 * 1.3.7 场景 1 — 存量 vm 环境条目「实例即环境」迁移 unit tests.
 *
 * 覆盖：旧条目识别（id=recipeId 且带 vmx 才命中；新口径/无 vmx/无
 * recipeId 不动；stem 解析失败与目标撞名跳过）、applyVmEntryRenames 的
 * 字段保留、env-sessions/selection 的 id 改名 helper、以及 runner 对
 * 临时目录的端到端 round-trip（config + 两个引用文件同步改名、幂等
 * 二次运行零改动、坏文件不炸）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AdminAppConfig } from '../utils/admin-config';
import type { EnvironmentEntry } from '../../shared/config-types';
import {
  loadEnvSessionsMap,
  renameEnvSessionEnvIdInMap,
  serializeEnvSessionsMap,
  type EnvSessionsMap,
} from './env-sessions';
import {
  loadSelectionStore,
  renameSelectionEnvIdInStore,
  serializeSelectionStore,
  type EnvSelectionStore,
} from './selection';
import {
  applyVmEntryRenames,
  runLegacyVmEntryMigration,
  scanLegacyVmTemplateEntries,
} from './vm-entry-migration';

function vmEntry(overrides: Partial<EnvironmentEntry>): EnvironmentEntry {
  return { id: 'x', kind: 'vm', vmName: 'x', createdAt: '2026-08-01T00:00:00.000Z', ...overrides };
}

const LEGACY: EnvironmentEntry = vmEntry({
  id: 'pwn-vm',
  recipeId: 'pwn-vm',
  vmName: 'pwn-vm',
  vmx: 'C:\\VMs\\kali\\kali.vmx',
  address: '192.168.1.10',
  user: 'researcher',
});

describe('scanLegacyVmTemplateEntries（旧口径识别）', () => {
  it('id=recipeId 且带 vmx 的 vm 条目 → 改名为 vmx stem', () => {
    const scan = scanLegacyVmTemplateEntries({ environments: [LEGACY] } as AdminAppConfig);
    expect(scan.renames).toEqual([{ oldId: 'pwn-vm', newId: 'kali' }]);
    expect(scan.skipped).toEqual([]);
  });

  it('新口径条目（id=vmName=stem，recipeId 仍指配方）不动', () => {
    const fresh = vmEntry({ id: 'kali', recipeId: 'pwn-vm', vmName: 'kali', vmx: 'C:\\VMs\\kali\\kali.vmx' });
    const scan = scanLegacyVmTemplateEntries({ environments: [fresh] } as AdminAppConfig);
    expect(scan.renames).toEqual([]);
  });

  it('id 恰等于 stem 的旧条目视为新口径（幂等关键）', () => {
    const e = vmEntry({ id: 'kali', recipeId: 'kali', vmName: 'kali', vmx: 'C:\\VMs\\kali\\kali.vmx' });
    expect(scanLegacyVmTemplateEntries({ environments: [e] } as AdminAppConfig).renames).toEqual([]);
  });

  it('无 vmx / 无 recipeId / 非 vm 条目不命中', () => {
    const entries = [
      vmEntry({ id: 'a', recipeId: 'a' }), // 无 vmx（hyperv/vbox 派生实例）
      vmEntry({ id: 'b', vmx: 'C:\\v\\b.vmx' }), // 无 recipeId（手动登记）
      { id: 'c', kind: 'docker', container: 'c', createdAt: 'x' } as EnvironmentEntry,
    ];
    expect(scanLegacyVmTemplateEntries({ environments: entries } as AdminAppConfig).renames).toEqual([]);
  });

  it('vmx 解析不出 stem → 跳过 + 原因', () => {
    const e = vmEntry({ id: 'p', recipeId: 'p', vmx: '.vmx' });
    const scan = scanLegacyVmTemplateEntries({ environments: [e] } as AdminAppConfig);
    expect(scan.renames).toEqual([]);
    expect(scan.skipped).toHaveLength(1);
    expect(scan.skipped[0]).toContain('p');
  });

  it('目标 id 已被其它条目占用 → 跳过 + 原因（不丢条目）', () => {
    const occupying = vmEntry({ id: 'kali', vmName: 'kali' });
    const scan = scanLegacyVmTemplateEntries({ environments: [LEGACY, occupying] } as AdminAppConfig);
    expect(scan.renames).toEqual([]);
    expect(scan.skipped[0]).toContain('占用');
  });
});

describe('applyVmEntryRenames（改名应用）', () => {
  it('id/vmName 改为实例名，vmx 与其余字段原样保留', () => {
    const next = applyVmEntryRenames({ environments: [LEGACY] } as AdminAppConfig, [
      { oldId: 'pwn-vm', newId: 'kali' },
    ]);
    const entry = next.environments![0];
    expect(entry.id).toBe('kali');
    expect(entry.vmName).toBe('kali');
    expect(entry.vmx).toBe('C:\\VMs\\kali\\kali.vmx');
    expect(entry.recipeId).toBe('pwn-vm');
    expect(entry.address).toBe('192.168.1.10');
    expect(entry.user).toBe('researcher');
  });

  it('空 renames → 原样返回（同一引用）', () => {
    const config = { environments: [LEGACY] } as AdminAppConfig;
    expect(applyVmEntryRenames(config, [])).toBe(config);
  });
});

describe('renameEnvSessionEnvIdInMap / renameSelectionEnvIdInStore（引用改名）', () => {
  it('env-sessions：env:/recipe: 行键后缀改名，目标已存在则保留现存行', () => {
    const map: EnvSessionsMap = {
      version: 1,
      lines: {
        'E:/w::env:pwn-vm': { loopSessionId: 'l1', updatedAt: 't1' },
        'E:/w::recipe:pwn-vm': { loopSessionId: 'l2', updatedAt: 't2' },
        'E:/w::host': { loopSessionId: 'l3', updatedAt: 't3' },
        'E:/w::env:kali': { loopSessionId: 'existing', updatedAt: 't0' },
      },
    };
    const next = renameEnvSessionEnvIdInMap(map, 'pwn-vm', 'kali');
    expect(next.lines['E:/w::env:kali']?.loopSessionId).toBe('existing'); // 现存行优先
    expect(next.lines['E:/w::recipe:kali']?.loopSessionId).toBe('l2');
    expect(next.lines['E:/w::env:pwn-vm']).toBeUndefined();
    expect(next.lines['E:/w::host']?.loopSessionId).toBe('l3');
  });

  it('env-sessions：无命中返回原 map（不写盘信号）', () => {
    const map: EnvSessionsMap = { version: 1, lines: { 'E:/w::host': { loopSessionId: 'l', updatedAt: 't' } } };
    expect(renameEnvSessionEnvIdInMap(map, 'pwn-vm', 'kali')).toBe(map);
  });

  it('selection：env.id 与 recipe.instanceId 改名，host/其它 id 不动', () => {
    const store: EnvSelectionStore = {
      version: 1,
      workspaces: {
        'E:/a': { selection: { kind: 'env', id: 'pwn-vm' }, selectedAt: 't' },
        'E:/b': { selection: { kind: 'recipe', name: 'pwn-vm', instanceId: 'pwn-vm' }, selectedAt: 't' },
        'E:/c': { selection: { kind: 'env', id: 'other' }, selectedAt: 't' },
        'E:/d': { selection: { kind: 'host' }, selectedAt: 't' },
      },
    };
    const next = renameSelectionEnvIdInStore(store, 'pwn-vm', 'kali');
    expect(next.workspaces['E:/a'].selection).toEqual({ kind: 'env', id: 'kali' });
    expect(next.workspaces['E:/b'].selection).toEqual({ kind: 'recipe', name: 'pwn-vm', instanceId: 'kali' });
    expect(next.workspaces['E:/c'].selection).toEqual({ kind: 'env', id: 'other' });
    expect(next.workspaces['E:/d'].selection).toEqual({ kind: 'host' });
  });

  it('selection：无命中返回原 store', () => {
    const store: EnvSelectionStore = {
      version: 1,
      workspaces: { 'E:/a': { selection: { kind: 'host' }, selectedAt: 't' } },
    };
    expect(renameSelectionEnvIdInStore(store, 'pwn-vm', 'kali')).toBe(store);
  });
});

describe('runLegacyVmEntryMigration（临时文件端到端）', () => {
  let dir: string;
  let configPath: string;
  let sessionsPath: string;
  let selectionPath: string;
  let logs: string[];
  let warns: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vm-migration-test-'));
    configPath = join(dir, 'config.json');
    sessionsPath = join(dir, 'env-sessions.json');
    selectionPath = join(dir, 'env-selection.json');
    logs = [];
    warns = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const opts = () => ({
    configPath,
    envSessionsPath: sessionsPath,
    envSelectionPath: selectionPath,
    log: (m: string) => logs.push(m),
    warn: (m: string) => warns.push(m),
  });

  function seedAll(): void {
    writeFileSync(configPath, JSON.stringify({ environments: [LEGACY] }), 'utf-8');
    writeFileSync(
      sessionsPath,
      serializeEnvSessionsMap({
        version: 1,
        lines: { 'E:/w::env:pwn-vm': { loopSessionId: 'l1', updatedAt: 't' } },
      }),
      'utf-8',
    );
    writeFileSync(
      selectionPath,
      serializeSelectionStore({
        version: 1,
        workspaces: { 'E:/w': { selection: { kind: 'env', id: 'pwn-vm' }, selectedAt: 't' } },
      }),
      'utf-8',
    );
  }

  it('三处同步改名 + 一行迁移日志', async () => {
    seedAll();
    const result = await runLegacyVmEntryMigration(opts());
    expect(result.migrated).toEqual([{ oldId: 'pwn-vm', newId: 'kali' }]);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.environments[0].id).toBe('kali');
    expect(config.environments[0].vmName).toBe('kali');
    expect(config.environments[0].vmx).toBe('C:\\VMs\\kali\\kali.vmx');

    const sessions = loadEnvSessionsMap(sessionsPath);
    expect(sessions.lines['E:/w::env:kali']?.loopSessionId).toBe('l1');

    const selection = loadSelectionStore(selectionPath);
    expect(selection.workspaces['E:/w'].selection).toEqual({ kind: 'env', id: 'kali' });

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('pwn-vm→kali');
  });

  it('幂等：二次运行零改名零日志，文件内容不再变化', async () => {
    seedAll();
    await runLegacyVmEntryMigration(opts());
    const configAfter1 = readFileSync(configPath, 'utf-8');
    logs = [];
    const second = await runLegacyVmEntryMigration(opts());
    expect(second.migrated).toEqual([]);
    expect(logs).toEqual([]);
    expect(readFileSync(configPath, 'utf-8')).toBe(configAfter1);
  });

  it('无旧条目 → 无操作无日志；config.json 不存在 → 直接返回', async () => {
    writeFileSync(configPath, JSON.stringify({ environments: [] }), 'utf-8');
    const r1 = await runLegacyVmEntryMigration(opts());
    expect(r1.migrated).toEqual([]);
    expect(logs).toEqual([]);

    const r2 = await runLegacyVmEntryMigration({ ...opts(), configPath: join(dir, 'nope.json') });
    expect(r2.migrated).toEqual([]);
  });

  it('config.json 损坏 → 跳过 + 告警，不抛异常', async () => {
    writeFileSync(configPath, '{ broken', 'utf-8');
    const result = await runLegacyVmEntryMigration(opts());
    expect(result.migrated).toEqual([]);
    expect(warns.some((w) => w.includes('解析失败'))).toBe(true);
  });

  it('引用文件损坏 → 改名容错（告警），条目本身已迁移', async () => {
    seedAll();
    writeFileSync(sessionsPath, '{ broken', 'utf-8');
    const result = await runLegacyVmEntryMigration(opts());
    expect(result.migrated).toEqual([{ oldId: 'pwn-vm', newId: 'kali' }]);
    // 损坏文件按空 map 处理（loadEnvSessionsMap 容错），改名后只含新键
    const sessions = loadEnvSessionsMap(sessionsPath);
    expect(sessions.lines['E:/w::env:pwn-vm']).toBeUndefined();
  });
});
