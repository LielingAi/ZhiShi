/**
 * 1.8.7 P3b 双线制——线读写权限矩阵（auth/line-access.ts）。
 *
 *   | 线型           | 读                 | 写            |
 *   | 私有线(默认)    | owner + reviewer   | 仅 owner      |
 *   | 共享线         | 全体成员           | operator+     |
 *   | 归属未知(旧线)  | 全体成员           | operator+     |
 *   | 本机(local)    | 恒放行             | 恒放行        |
 */

import { describe, expect, it } from 'vitest';

import type { Actor } from './actor';
import { canReadLine, canWriteLine, canRespondToPending } from './line-access';
import type { LineOwnership } from '../loop/line-ownership';

const alice: Actor = { name: 'alice', role: 'operator', source: 'token' };
const bob: Actor = { name: 'bob', role: 'operator', source: 'token' };
const reviewer: Actor = { name: 'carol', role: 'reviewer', source: 'token' };
const reader: Actor = { name: 'dave', role: 'readonly', source: 'token' };
const local: Actor = { name: 'local', role: 'reviewer', source: 'local' };

const alicePrivate: LineOwnership = { owner: 'alice', shared: false, updatedAt: '' };
const sharedLine: LineOwnership = { owner: 'alice', shared: true, updatedAt: '' };

describe('P3b 线权限矩阵(双线制)', () => {
  it('私有线:读 = owner + reviewer;写 = 仅 owner', () => {
    expect(canReadLine(alice, alicePrivate)).toBe(true); // owner
    expect(canReadLine(reviewer, alicePrivate)).toBe(true); // reviewer
    expect(canReadLine(bob, alicePrivate)).toBe(false); // 非主非 reviewer
    expect(canReadLine(reader, alicePrivate)).toBe(false);
    expect(canWriteLine(alice, alicePrivate)).toBe(true); // owner
    expect(canWriteLine(bob, alicePrivate)).toBe(false); // 非主 → 403 的判定源
    expect(canWriteLine(reviewer, alicePrivate)).toBe(false); // reviewer 也不能写他人私有线
  });

  it('共享线:全员可读;operator+ 可写(readonly 不可)', () => {
    expect(canReadLine(bob, sharedLine)).toBe(true);
    expect(canReadLine(reader, sharedLine)).toBe(true);
    expect(canWriteLine(alice, sharedLine)).toBe(true);
    expect(canWriteLine(bob, sharedLine)).toBe(true);
    expect(canWriteLine(reader, sharedLine)).toBe(false);
  });

  it('归属未知(无记录/无 owner):全员可读;operator+ 可写——文档化缺省', () => {
    expect(canReadLine(reader, undefined)).toBe(true);
    expect(canWriteLine(bob, undefined)).toBe(true);
    expect(canWriteLine(reader, undefined)).toBe(false); // readonly 不可写
    const ownerUnknown: LineOwnership = { updatedAt: '' };
    expect(canReadLine(reader, ownerUnknown)).toBe(true);
    expect(canWriteLine(alice, ownerUnknown)).toBe(true);
  });

  it('本机 actor(source=local)恒放行——单用户模式逐字节不变', () => {
    expect(canReadLine(local, alicePrivate)).toBe(true);
    expect(canWriteLine(local, alicePrivate)).toBe(true);
    expect(canReadLine(local, undefined)).toBe(true);
    expect(canWriteLine(local, undefined)).toBe(true);
  });

  it('审批应答（B 案）:reviewer 任何线可答;operator 仅答自己名下私有线', () => {
    // reviewer：私有/共享/归属未知/admin 类（无 ownership）全可答
    expect(canRespondToPending(reviewer, alicePrivate)).toBe(true);
    expect(canRespondToPending(reviewer, sharedLine)).toBe(true);
    expect(canRespondToPending(reviewer, undefined)).toBe(true);
    // operator owner：自己名下私有线可答（「自己的线自己批」）
    expect(canRespondToPending(alice, alicePrivate)).toBe(true);
    // operator 非主：他人私有线 403 的判定源
    expect(canRespondToPending(bob, alicePrivate)).toBe(false);
    // operator 在共享线上：维持 reviewer-only（即使 operator 能写共享线）
    expect(canRespondToPending(alice, sharedLine)).toBe(false);
    expect(canRespondToPending(bob, sharedLine)).toBe(false);
    // operator 在归属未知旧线 / admin 类 ask（无 ownership）：维持 reviewer-only
    expect(canRespondToPending(bob, undefined)).toBe(false);
    expect(canRespondToPending(bob, { updatedAt: '' })).toBe(false);
    // readonly：一律不可答
    expect(canRespondToPending(reader, alicePrivate)).toBe(false);
    expect(canRespondToPending(reader, sharedLine)).toBe(false);
    // 本机 actor 恒放行
    expect(canRespondToPending(local, alicePrivate)).toBe(true);
    expect(canRespondToPending(local, undefined)).toBe(true);
  });
});
