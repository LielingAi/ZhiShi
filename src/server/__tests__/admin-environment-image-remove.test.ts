/**
 * 1.6.3 #8 — environment/image-remove 镜像删除端点的接线测试。
 *
 * 配置注入照 admin 测试惯例（临时 HOME + ~/.zhishi/config.json 播种）；
 * docker 通道走 __setImageRemoveOpsForTests 假通道，绝不真调 docker。
 *
 * 覆盖：
 *  - 缺 id → 可读错误；
 *  - 安全闸①：登记在册的 docker 环境占用该镜像（含 `name` ≈ `name:latest`
 *    缺省 tag 语义）→ 拒绝并指明占用环境，rmImage 不被调用；
 *  - 安全闸②：容器（含已退出）引用该镜像 → 拒绝并指明容器；
 *  - 无占用无引用 → docker rmi 实删成功；
 *  - rmi 失败 → 错误透传；
 *  - psAll 探测失败（docker 不可用）→ 放行到 rmi（口径照 environment/rm
 *    探测失败放行），由 daemon 侧给可读错误。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __setImageRemoveOpsForTests,
  handleEnvironmentImageRemove,
  type ImageRemoveOps,
} from '../admin-api';
import type { EnvironmentEntry } from '../../shared/config-types';
import type { DiscoveredDocker } from '../environment/docker-lifecycle';

let scratch: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

const DOCKER_ENTRY: EnvironmentEntry = {
  id: 'zhishi-pwn-a3f2',
  kind: 'docker',
  container: 'zhishi-pwn-a3f2',
  recipeId: 'pwn',
  createdAt: '2026-08-25T00:00:00Z',
};

function seedEntries(entries: EnvironmentEntry[]): void {
  writeFileSync(
    join(scratch, '.zhishi', 'config.json'),
    JSON.stringify({ environments: entries }),
    'utf-8',
  );
}

function container(name: string, image: string): DiscoveredDocker {
  return { id: name.slice(0, 12), name, image, status: 'Exited (0) 2 days ago', managed: true };
}

function fakeOps(overrides: Partial<ImageRemoveOps>, calls: string[]): ImageRemoveOps {
  return {
    psAll: () => {
      calls.push('psAll');
      return Promise.resolve({ ok: true as const, instances: [] });
    },
    rmImage: (image) => {
      calls.push(`rmImage:${image}`);
      return Promise.resolve({ ok: true as const, removed: image });
    },
    ...overrides,
  };
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'zhishi-image-remove-'));
  mkdirSync(join(scratch, '.zhishi'), { recursive: true });
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = scratch;
  process.env.USERPROFILE = scratch;
});

afterEach(() => {
  __setImageRemoveOpsForTests(null);
  process.env.HOME = prevHome;
  process.env.USERPROFILE = prevUserProfile;
  rmSync(scratch, { recursive: true, force: true });
});

describe('handleEnvironmentImageRemove — 入参与安全闸', () => {
  it('缺 id → 可读错误', async () => {
    const r = await handleEnvironmentImageRemove({});
    expect(r.success).toBe(false);
    expect(r.error).toContain('<id>');
  });

  it('安全闸①：登记在册的 docker 环境占用该镜像 → 拒绝并指明环境，rmImage 不调用', async () => {
    seedEntries([DOCKER_ENTRY]);
    const calls: string[] = [];
    __setImageRemoveOpsForTests(fakeOps({}, calls));
    const r = await handleEnvironmentImageRemove({ id: 'zhishi-env-pwn:latest' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('zhishi-pwn-a3f2');
    expect(r.error).toContain('zhishi env rm');
    expect(calls).toEqual([]); // 登记占用在册即拒——连容器探测都不需要
  });

  it('安全闸①吃缺省 tag 语义：无 tag 的 `zhishi-env-pwn` 同样命中登记占用', async () => {
    seedEntries([DOCKER_ENTRY]);
    const calls: string[] = [];
    __setImageRemoveOpsForTests(fakeOps({}, calls));
    const r = await handleEnvironmentImageRemove({ id: 'zhishi-env-pwn' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('zhishi-pwn-a3f2');
    expect(calls).toEqual([]);
  });

  it('安全闸②：未登记但有容器引用（含已退出）→ 拒绝并指明容器', async () => {
    seedEntries([]);
    const calls: string[] = [];
    __setImageRemoveOpsForTests(fakeOps({
      psAll: () => Promise.resolve({
        ok: true as const,
        instances: [container('zhishi-fuzz-b1c2', 'zhishi-env-fuzz:latest')],
      }),
    }, calls));
    const r = await handleEnvironmentImageRemove({ id: 'zhishi-env-fuzz' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('zhishi-fuzz-b1c2');
    expect(r.error).toContain('引用');
    expect(calls).not.toContain('rmImage:zhishi-env-fuzz');
  });

  it('非 docker 条目（ssh/vm）不占镜像——不误伤', async () => {
    seedEntries([{ id: 'range-1', kind: 'ssh', host: '10.0.0.1', createdAt: DOCKER_ENTRY.createdAt }]);
    const calls: string[] = [];
    __setImageRemoveOpsForTests(fakeOps({}, calls));
    const r = await handleEnvironmentImageRemove({ id: 'zhishi-env-pwn:latest' });
    expect(r.success).toBe(true);
    expect(calls).toEqual(['psAll', 'rmImage:zhishi-env-pwn:latest']);
  });
});

describe('handleEnvironmentImageRemove — 实删与降级', () => {
  it('无占用无引用 → docker rmi 实删成功，回包 removed', async () => {
    seedEntries([DOCKER_ENTRY]);
    const calls: string[] = [];
    __setImageRemoveOpsForTests(fakeOps({}, calls));
    const r = await handleEnvironmentImageRemove({ id: 'zhishi-env-re:latest' });
    expect(r.success).toBe(true);
    expect((r.data as { removed: string }).removed).toBe('zhishi-env-re:latest');
    expect(calls).toEqual(['psAll', 'rmImage:zhishi-env-re:latest']);
  });

  it('rmi 失败 → 错误透传（daemon 侧可读错误）', async () => {
    seedEntries([]);
    __setImageRemoveOpsForTests(fakeOps({
      rmImage: () => Promise.resolve({ ok: false as const, error: 'docker rmi 失败（镜像 "x"）：\nNo such image' }),
    }, []));
    const r = await handleEnvironmentImageRemove({ id: 'x:latest' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('No such image');
  });

  it('psAll 探测失败（docker 不可用）→ 放行到 rmi，由 daemon 侧给错误（口径照 environment/rm）', async () => {
    seedEntries([]);
    const calls: string[] = [];
    __setImageRemoveOpsForTests(fakeOps({
      psAll: () => {
        calls.push('psAll');
        return Promise.resolve({ ok: false as const, error: 'docker ps -a 失败' });
      },
    }, calls));
    const r = await handleEnvironmentImageRemove({ id: 'zhishi-env-re:latest' });
    expect(r.success).toBe(true);
    expect(calls).toEqual(['psAll', 'rmImage:zhishi-env-re:latest']);
  });
});
