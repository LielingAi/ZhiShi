/**
 * 安全研究员版 P1 E3 — named-environment registry unit tests.
 *
 * Pure-logic coverage: entry validation (per-kind required fields, D-T4
 * credential rule), id uniqueness on add/remove, open-command resolution
 * (ssh/docker/vm mappings incl. user/keyPath combinations and the vm
 * without-address error path), and legacy-config tolerance (configs without
 * an `environments` field behave as an empty registry).
 */
import { describe, expect, it } from 'vitest';

import type { EnvironmentEntry } from '../../shared/config-types';
import {
  addEnvironmentEntry,
  envTagForEntry,
  findEnvironmentEntry,
  listEnvironments,
  removeEnvironmentEntry,
  resolveEnvOpenCommand,
  validateEnvironmentEntry,
} from './registry';

function sshEntry(overrides: Partial<EnvironmentEntry> = {}): EnvironmentEntry {
  return {
    id: 'dev-box',
    kind: 'ssh',
    host: '10.0.0.8',
    createdAt: '2026-08-14T00:00:00.000Z',
    ...overrides,
  };
}

describe('validateEnvironmentEntry', () => {
  it('rejects non-object input', () => {
    expect(validateEnvironmentEntry(null).ok).toBe(false);
    expect(validateEnvironmentEntry('ssh').ok).toBe(false);
    expect(validateEnvironmentEntry(42).ok).toBe(false);
  });

  it('rejects missing / empty / whitespace-containing id', () => {
    expect(validateEnvironmentEntry({ kind: 'ssh', host: 'h' }).ok).toBe(false);
    expect(validateEnvironmentEntry({ id: '', kind: 'ssh', host: 'h' }).ok).toBe(false);
    expect(validateEnvironmentEntry({ id: '  ', kind: 'ssh', host: 'h' }).ok).toBe(false);
    const bad = validateEnvironmentEntry({ id: 'my env', kind: 'ssh', host: 'h' });
    expect(bad.ok).toBe(false);
  });

  it('rejects missing or unknown kind', () => {
    expect(validateEnvironmentEntry({ id: 'x', host: 'h' }).ok).toBe(false);
    const bad = validateEnvironmentEntry({ id: 'x', kind: 'telnet', host: 'h' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('kind');
  });

  it('ssh requires host', () => {
    const bad = validateEnvironmentEntry({ id: 'x', kind: 'ssh' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('host');
    expect(validateEnvironmentEntry({ id: 'x', kind: 'ssh', host: 'example.com' }).ok).toBe(true);
  });

  it('docker requires container', () => {
    const bad = validateEnvironmentEntry({ id: 'x', kind: 'docker' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('container');
    expect(validateEnvironmentEntry({ id: 'x', kind: 'docker', container: 'ctf' }).ok).toBe(true);
  });

  it('vm requires vmName (address stays optional)', () => {
    const bad = validateEnvironmentEntry({ id: 'x', kind: 'vm' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('vmName');
    expect(validateEnvironmentEntry({ id: 'x', kind: 'vm', vmName: 'win11-range' }).ok).toBe(true);
  });

  it('D-T4: rejects password/passphrase fields — only keyPath references are stored', () => {
    const withPassword = validateEnvironmentEntry({
      id: 'x', kind: 'ssh', host: 'h', password: 'hunter2',
    });
    expect(withPassword.ok).toBe(false);
    if (!withPassword.ok) expect(withPassword.error).toContain('keyPath');

    const withPassphrase = validateEnvironmentEntry({
      id: 'x', kind: 'ssh', host: 'h', passphrase: 'secret',
    });
    expect(withPassphrase.ok).toBe(false);
  });

  it('trims strings and keeps optional fields when valid', () => {
    const ok = validateEnvironmentEntry({
      id: '  lab ',
      kind: 'ssh',
      name: '实验机',
      host: ' 10.0.0.8 ',
      user: 'root',
      keyPath: '~/.ssh/id_ed25519',
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.entry).toEqual({
        id: 'lab',
        kind: 'ssh',
        name: '实验机',
        host: '10.0.0.8',
        user: 'root',
        keyPath: '~/.ssh/id_ed25519',
      });
    }
  });

  it('rejects non-string optional fields', () => {
    expect(validateEnvironmentEntry({ id: 'x', kind: 'ssh', host: 'h', user: 1 }).ok).toBe(false);
    expect(validateEnvironmentEntry({ id: 'x', kind: 'ssh', host: 'h', keyPath: {} }).ok).toBe(false);
  });
});

describe('addEnvironmentEntry / removeEnvironmentEntry / findEnvironmentEntry', () => {
  it('appends a new entry without mutating the input list', () => {
    const before = [sshEntry()];
    const added = addEnvironmentEntry(before, sshEntry({ id: 'box-2' }));
    expect(added.ok).toBe(true);
    if (added.ok) {
      expect(added.entries).toHaveLength(2);
      expect(added.entries[1].id).toBe('box-2');
    }
    expect(before).toHaveLength(1);
  });

  it('rejects duplicate ids', () => {
    const dup = addEnvironmentEntry([sshEntry()], sshEntry({ host: 'other' }));
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error).toContain('dev-box');
  });

  it('removes by id and reports the removed entry', () => {
    const list = [sshEntry(), sshEntry({ id: 'box-2' })];
    const removed = removeEnvironmentEntry(list, 'dev-box');
    expect(removed.ok).toBe(true);
    if (removed.ok) {
      expect(removed.entries.map((e) => e.id)).toEqual(['box-2']);
      expect(removed.removed.id).toBe('dev-box');
    }
  });

  it('remove of an unknown id fails with a clear error', () => {
    const missing = removeEnvironmentEntry([sshEntry()], 'nope');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain('nope');
  });

  it('find returns the entry or undefined', () => {
    const list = [sshEntry()];
    expect(findEnvironmentEntry(list, 'dev-box')?.host).toBe('10.0.0.8');
    expect(findEnvironmentEntry(list, 'nope')).toBeUndefined();
  });
});

describe('resolveEnvOpenCommand', () => {
  it('ssh with host only → ssh <host>', () => {
    const r = resolveEnvOpenCommand(sshEntry());
    expect(r).toEqual({ ok: true, cmd: 'ssh 10.0.0.8' });
  });

  it('ssh with user → ssh <user>@<host>', () => {
    const r = resolveEnvOpenCommand(sshEntry({ user: 'root' }));
    expect(r).toEqual({ ok: true, cmd: 'ssh root@10.0.0.8' });
  });

  it('ssh with keyPath adds -i (before the target)', () => {
    const r = resolveEnvOpenCommand(sshEntry({ user: 'root', keyPath: '~/.ssh/id_ed25519' }));
    expect(r).toEqual({ ok: true, cmd: 'ssh -i ~/.ssh/id_ed25519 root@10.0.0.8' });
  });

  it('quotes arguments containing whitespace', () => {
    const keyPath = 'C:\\Users\\me\\my key.pem';
    const r = resolveEnvOpenCommand(sshEntry({ keyPath }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cmd).toBe(`ssh -i ${JSON.stringify(keyPath)} 10.0.0.8`);
  });

  it('docker → docker exec -it <container> bash', () => {
    const r = resolveEnvOpenCommand({
      id: 'ctf', kind: 'docker', container: 'pwn-box', createdAt: 'x',
    });
    expect(r).toEqual({ ok: true, cmd: 'docker exec -it pwn-box bash' });
  });

  it('vm with address behaves like ssh (user/keyPath supported)', () => {
    const r = resolveEnvOpenCommand({
      id: 'range', kind: 'vm', vmName: 'win11-range', address: '192.168.56.10',
      user: 'analyst', keyPath: '~/.ssh/range_key', createdAt: 'x',
    });
    expect(r).toEqual({ ok: true, cmd: 'ssh -i ~/.ssh/range_key analyst@192.168.56.10' });
  });

  it('vm without address → error pointing at the guest-exec channel', () => {
    const r = resolveEnvOpenCommand({
      id: 'range', kind: 'vm', vmName: 'win11-range', createdAt: 'x',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('win11-range');
      expect(r.error).toContain('guest-exec');
    }
  });
});

describe('envTagForEntry (P1 E6 — D14 边界标记)', () => {
  it('docker → docker:<container>', () => {
    expect(envTagForEntry({ id: 'ctf', kind: 'docker', container: 'pwn-box', createdAt: 'x' }))
      .toBe('docker:pwn-box');
  });

  it('vm → vm:<vmName>（即使有 address 走 ssh 接入，标记仍是 vm）', () => {
    expect(envTagForEntry({ id: 'range', kind: 'vm', vmName: 'win11-range', address: '192.168.56.10', createdAt: 'x' }))
      .toBe('vm:win11-range');
  });

  it('ssh → range:<host>', () => {
    expect(envTagForEntry(sshEntry())).toBe('range:10.0.0.8');
  });

  it('字段缺省时兜底 entry.id（防御；validate 正常已拦截）', () => {
    expect(envTagForEntry({ id: 'x', kind: 'docker', createdAt: 't' })).toBe('docker:x');
    expect(envTagForEntry({ id: 'x', kind: 'vm', createdAt: 't' })).toBe('vm:x');
    expect(envTagForEntry({ id: 'x', kind: 'ssh', createdAt: 't' })).toBe('range:x');
  });
});

describe('legacy config compatibility (no environments field)', () => {
  it('listEnvironments returns [] for configs without the field', () => {
    expect(listEnvironments({})).toEqual([]);
    expect(listEnvironments({ defaultProviderId: 'x' })).toEqual([]);
    expect(listEnvironments({ environments: [sshEntry()] })).toHaveLength(1);
  });

  it('add/remove tolerate an undefined existing list', () => {
    const added = addEnvironmentEntry(undefined, sshEntry());
    expect(added.ok).toBe(true);
    if (added.ok) expect(added.entries).toHaveLength(1);

    const removed = removeEnvironmentEntry(undefined, 'dev-box');
    expect(removed.ok).toBe(false);
  });
});

describe('port field (P2 B5)', () => {
  it('accepts numeric or numeric-string port, rejects out-of-range', () => {
    const ok1 = validateEnvironmentEntry({ id: 'v1', kind: 'vm', vmName: 'w', address: '10.0.0.8', port: 2222 });
    expect(ok1.ok && ok1.entry.port).toBe(2222);
    const ok2 = validateEnvironmentEntry({ id: 'v2', kind: 'ssh', host: 'h', port: '2223' });
    expect(ok2.ok && ok2.entry.port).toBe(2223);
    expect(validateEnvironmentEntry({ id: 'v3', kind: 'ssh', host: 'h', port: 0 }).ok).toBe(false);
    expect(validateEnvironmentEntry({ id: 'v4', kind: 'ssh', host: 'h', port: 'abc' }).ok).toBe(false);
    expect(validateEnvironmentEntry({ id: 'v5', kind: 'ssh', host: 'h', port: 70000 }).ok).toBe(false);
  });

  it('resolveEnvOpenCommand emits -p for ssh and vm-with-address', () => {
    const ssh = resolveEnvOpenCommand({ id: 's', kind: 'ssh', host: 'h', user: 'u', port: 2222, createdAt: '' });
    expect(ssh.ok && ssh.cmd).toBe('ssh -p 2222 u@h');
    const vm = resolveEnvOpenCommand({ id: 'v', kind: 'vm', vmName: 'w', address: '10.0.0.8', user: 'researcher', keyPath: '/k', port: 2200, createdAt: '' });
    expect(vm.ok && vm.cmd).toBe('ssh -p 2200 -i /k researcher@10.0.0.8');
    // 无 port 时不出现 -p
    const plain = resolveEnvOpenCommand({ id: 's2', kind: 'ssh', host: 'h', createdAt: '' });
    expect(plain.ok && plain.cmd).toBe('ssh h');
  });
});
