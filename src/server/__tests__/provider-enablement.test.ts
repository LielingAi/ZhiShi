import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let scratch: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'zhishi-provider-enable-'));
  const configDir = join(scratch, '.zhishi');
  const providersDir = join(configDir, 'providers');
  mkdirSync(providersDir, { recursive: true });

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

function writeCustomProvider(id: string): void {
  writeFileSync(
    join(scratch, '.zhishi', 'providers', `${id}.json`),
    JSON.stringify({
      id,
      name: 'Custom Provider',
      vendor: 'Custom',
      cloudProvider: 'Custom',
      type: 'api',
      primaryModel: 'custom-model',
      isBuiltin: false,
      authType: 'api_key',
      config: {
        baseUrl: 'https://custom.example/v1',
      },
      models: [
        { model: 'custom-model', modelName: 'Custom Model', modelSeries: 'custom' },
      ],
    }, null, 2),
    'utf-8',
  );
}

describe('server-side provider enablement', () => {
  it('does not resolve disabled providers for background runtime startup', async () => {
    const { resolveProviderEnv, resolveWorkspaceConfig } = await import('../utils/admin-config');
    const providerId = 'custom-disabled';
    const workspacePath = join(scratch, 'workspace');
    writeCustomProvider(providerId);

    writeFileSync(
      join(scratch, '.zhishi', 'config.json'),
      JSON.stringify({
        providerApiKeys: {
          [providerId]: 'provider-secret',
        },
        disabledProviderIds: [providerId],
        agents: [
          {
            id: 'agent-1',
            name: 'Agent',
            enabled: true,
            workspacePath,
            providerId,
          },
        ],
      }, null, 2),
      'utf-8',
    );
    writeFileSync(join(scratch, '.zhishi', 'projects.json'), '[]', 'utf-8');

    expect(resolveProviderEnv(providerId)).toBeUndefined();
    const resolved = resolveWorkspaceConfig(workspacePath);
    expect(resolved.providerEnv).toBeUndefined();
    expect(resolved.model).toBeUndefined();
  });
});
