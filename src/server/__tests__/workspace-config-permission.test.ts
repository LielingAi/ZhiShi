import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionMetadata } from '../types/session';

let scratch: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

function writeConfig(config: Record<string, unknown>): void {
  writeFileSync(
    join(scratch, '.zhishi', 'config.json'),
    JSON.stringify(config, null, 2),
    'utf-8',
  );
}

function writeProjects(projects: Array<Record<string, unknown>>): void {
  writeFileSync(
    join(scratch, '.zhishi', 'projects.json'),
    JSON.stringify(projects, null, 2),
    'utf-8',
  );
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'zhishi-workspace-perm-'));
  mkdirSync(join(scratch, '.zhishi'), { recursive: true });
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = scratch;
  process.env.USERPROFILE = scratch;
});

afterEach(() => {
  process.env.HOME = prevHome;
  process.env.USERPROFILE = prevUserProfile;
  rmSync(scratch, { recursive: true, force: true });
});

describe('resolveWorkspaceConfig permissionMode (#295)', () => {
  it('returns agent permissionMode so pre-warm starts under the configured mode', async () => {
    const workspacePath = join(scratch, 'workspace');
    writeConfig({
      defaultPermissionMode: 'auto',
      agents: [{
        id: 'agent-1',
        name: 'Plan Agent',
        enabled: true,
        workspacePath,
        permissionMode: 'custom',
      }],
    });
    writeProjects([]);

    const { resolveWorkspaceConfig } = await import('../utils/admin-config');
    const resolved = resolveWorkspaceConfig(workspacePath, null);

    expect(resolved.permissionMode).toBe('custom');
  });

  it('prefers session snapshot before agent, then project, then global default', async () => {
    const workspacePath = join(scratch, 'workspace');
    writeConfig({
      defaultPermissionMode: 'fullAgency',
      agents: [{
        id: 'agent-1',
        name: 'Snapshot Agent',
        enabled: true,
        workspacePath,
        permissionMode: 'custom',
      }],
    });
    writeProjects([{
      id: 'project-1',
      name: 'Project',
      path: workspacePath,
      permissionMode: 'auto',
    }]);

    const { resolveWorkspaceConfig } = await import('../utils/admin-config');
    expect(resolveWorkspaceConfig(workspacePath, { permissionMode: 'fullAgency' } as SessionMetadata).permissionMode).toBe('fullAgency');

    writeConfig({
      defaultPermissionMode: 'fullAgency',
      agents: [{
        id: 'agent-1',
        name: 'Project Fallback Agent',
        enabled: true,
        workspacePath,
      }],
    });
    expect(resolveWorkspaceConfig(workspacePath, null).permissionMode).toBe('auto');

    writeProjects([]);
    expect(resolveWorkspaceConfig(workspacePath, null).permissionMode).toBe('fullAgency');
  });

  it('falls back to auto when no valid builtin permission mode is configured', async () => {
    const workspacePath = join(scratch, 'workspace');
    writeConfig({
      defaultPermissionMode: 'bypassPermissions',
      agents: [{
        id: 'agent-1',
        name: 'Malformed Agent',
        enabled: true,
        workspacePath,
        permissionMode: 'not-a-builtin-mode',
      }],
    });
    writeProjects([{
      id: 'project-1',
      name: 'Project',
      path: workspacePath,
      permissionMode: 'full-auto',
    }]);

    const { resolveWorkspaceConfig } = await import('../utils/admin-config');
    const resolved = resolveWorkspaceConfig(workspacePath, null);

    expect(resolved.permissionMode).toBe('auto');
  });
});
