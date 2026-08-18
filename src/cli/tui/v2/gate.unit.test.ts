/**
 * gate unit tests — data gathering degradation + option building + cursor
 * model. Commit paths live in integration.sse-replay.unit.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { SidecarClient, type FetchLike, type FetchResponseLike } from '../client';
import {
  gatherGateData,
  buildGateOptions,
  moveGateCursor,
  firstEnabledIndex,
  type GateData,
  type GateOption,
} from './gate';

function fakeClient(handlers: Record<string, unknown>, failRoutes: string[] = []): SidecarClient {
  const fetchImpl: FetchLike = (async (url: string) => {
    const route = url.replace(/^https?:\/\/test\//, '');
    if (failRoutes.some((r) => route.includes(r))) throw new Error('boom');
    const body = (handlers[route] ?? { success: true, data: {} }) as Record<string, unknown>;
    const res: FetchResponseLike = {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => 'application/json' },
      json: async () => body,
      text: async () => JSON.stringify(body),
      body: null,
    };
    return res;
  }) as FetchLike;
  return new SidecarClient({ base: 'http://test', fetchImpl });
}

function baseData(patch: Partial<GateData> = {}): GateData {
  return {
    environments: [],
    instances: [],
    recipes: [],
    dockerAvailable: true,
    discovered: { docker: [], vm: [] },
    ...patch,
  };
}

describe('gatherGateData', () => {
  it('degrades a failed path to empty without blocking the others', async () => {
    const client = fakeClient(
      {
        'api/admin/environment/list': { success: true, data: { environments: [{ id: 'vm1', kind: 'vm' }] } },
      },
      ['environment/ps', 'environment/discover'],
    );
    const data = await gatherGateData(client);
    expect(data.environments).toHaveLength(1);
    expect(data.instances).toEqual([]);
    expect(data.discovered).toEqual({ docker: [], vm: [] });
  });
});

describe('buildGateOptions', () => {
  it('splits registered envs into running/stopped via ps instances', () => {
    const opts = buildGateOptions(
      baseData({
        environments: [
          { id: 'live', kind: 'docker', container: 'c1' },
          { id: 'dead', kind: 'vm' },
        ],
        instances: [{ name: 'c1', status: 'running' }],
      }),
    );
    expect(opts.find((o) => o.envId === 'live')?.group).toBe('running');
    expect(opts.find((o) => o.envId === 'dead')?.group).toBe('stopped');
  });

  it('dedupes discovered entries already registered (by container / vmx / id)', () => {
    const opts = buildGateOptions(
      baseData({
        environments: [{ id: 'd1', kind: 'docker', container: 'web' }],
        discovered: {
          docker: [
            { id: 'x1', name: 'web', image: 'nginx', status: 'Up', managed: false }, // dup
            { id: 'x2', name: 'db', image: 'pg', status: 'Up', managed: false }, // new
            { id: 'x3', name: 'ours', image: 'z', status: 'Up', managed: true }, // managed → skip
          ],
          vm: [],
        },
      }),
    );
    const discovered = opts.filter((o) => o.group === 'discovered');
    expect(discovered).toHaveLength(1);
    expect(discovered[0].label).toBe('db');
  });

  it('marks recipes disabled when docker is unavailable, with reason', () => {
    const opts = buildGateOptions(
      baseData({
        dockerAvailable: false,
        dockerUnavailableReason: '未检测到容器引擎',
        recipes: [{ id: 'r1', name: 'pwn', valid: true, base: 'docker' }],
      }),
    );
    expect(opts[0].disabled).toBe(true);
    expect(opts[0].disabledReason).toBe('未检测到容器引擎');
  });
});

describe('cursor model', () => {
  const opt = (disabled: boolean): GateOption => ({
    key: Math.random().toString(36),
    group: 'running',
    label: 'x',
    detail: '',
    disabled,
  });

  it('moveGateCursor skips disabled options and wraps around', () => {
    const options = [opt(false), opt(true), opt(false)];
    expect(moveGateCursor(options, 0, 1)).toBe(2);
    expect(moveGateCursor(options, 2, 1)).toBe(0);
    expect(moveGateCursor(options, 0, -1)).toBe(2);
  });

  it('firstEnabledIndex finds the first selectable option', () => {
    expect(firstEnabledIndex([opt(true), opt(false)])).toBe(1);
    expect(firstEnabledIndex([opt(true)])).toBe(-1);
  });
});
