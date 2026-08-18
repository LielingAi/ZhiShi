import { describe, expect, it } from 'vitest';

import type { AgentConfig } from '../../shared/types/agent';
import {
  createMaterializedSessionMetadata,
} from './session-materialization';

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'agent-1',
    name: 'Agent',
    enabled: true,
    workspacePath: '/tmp/workspace',
    permissionMode: 'fullAgency',
    model: 'claude-sonnet-4-6',
    mcpEnabledServers: ['fs'],
    channels: [],
    runtime: 'codex',
    runtimeConfig: {
      model: 'gpt-5.1-codex',
      permissionMode: 'fullAgency',
    },
    ...overrides,
  };
}

describe('createMaterializedSessionMetadata', () => {
  it('keeps desktop materialization owned and self-contained', () => {
    const meta = createMaterializedSessionMetadata({
      agentDir: '/tmp/workspace',
      sessionId: 'desktop-session-id',
      scenario: 'desktop',
      agent: makeAgent(),
      title: 'First prompt',
    });

    expect(meta.id).toBe('desktop-session-id');
    expect(meta.title).toBe('First prompt');
    expect(meta.runtime).toBe('codex');
    expect(meta.model).toBe('gpt-5.1-codex');
    expect(meta.permissionMode).toBe('fullAgency');
    expect(meta.configSnapshotAt).toBeTruthy();
  });

  it('keeps cron materialization owned and self-contained', () => {
    const meta = createMaterializedSessionMetadata({
      agentDir: '/tmp/workspace',
      sessionId: 'cron-session-id',
      scenario: 'cron',
      agent: makeAgent(),
    });

    expect(meta.id).toBe('cron-session-id');
    expect(meta.runtime).toBe('codex');
    expect(meta.model).toBe('gpt-5.1-codex');
    expect(meta.configSnapshotAt).toBeTruthy();
  });

  it('uses the active runtime fallback when no agent config is available', () => {
    const meta = createMaterializedSessionMetadata({
      agentDir: '/tmp/unregistered-workspace',
      sessionId: 'external-reset-session-id',
      scenario: 'desktop',
      fallbackRuntime: 'codex',
    });

    expect(meta.id).toBe('external-reset-session-id');
    expect(meta.runtime).toBe('codex');
    expect(meta.model).toBeUndefined();
  });
});
