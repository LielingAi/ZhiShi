/**
 * expert/validate.ts 单测（1.2.1 骨架期）——格式契约单点校验全分支。
 */
import { describe, expect, it } from 'vitest';

import {
  computeContentHash,
  EXPERT_ENTRY_KINDS,
  EXPERT_PROVENANCES,
  isExpertEntryKind,
  isExpertProvenance,
  validateEntry,
  type ExpertEntryInput,
} from './validate';

function validInput(overrides: Partial<ExpertEntryInput> = {}): ExpertEntryInput {
  return {
    domain: 'binary',
    kind: 'technique',
    title: '栈溢出 triage',
    applicability: '拿到崩溃现场先看什么',
    content: '正文',
    criteria: '判据',
    provenance: 'user',
    reviewer: 'alice',
    ...overrides,
  };
}

describe('validateEntry', () => {
  it('合法输入全字段规范化（trim、tags 默认空、enabled 默认 true）', () => {
    const r = validateEntry(validInput({ title: '  标题  ', tags: ' a,b ' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.title).toBe('标题');
    expect(r.value.tags).toBe('a,b');
    expect(r.value.enabled).toBe(true);
    expect(r.value.sourceEventId).toBeNull();
    expect(r.value.reviewer).toBe('alice');
  });

  it('缺省 tags/enabled 有默认值', () => {
    const r = validateEntry(validInput());
    expect(r.ok && r.value.tags).toBe('');
    expect(r.ok && r.value.enabled).toBe(true);
  });

  it('kind 闭集：idea/technique/sop 通过，其他拒绝', () => {
    for (const k of EXPERT_ENTRY_KINDS) {
      expect(validateEntry(validInput({ kind: k })).ok).toBe(true);
    }
    const bad = validateEntry(validInput({ kind: 'method' }));
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors.join()).toContain('kind 非法');
  });

  it('domain 闭集：RESEARCH_TASK_KINDS 外拒绝', () => {
    expect(validateEntry(validInput({ domain: 'web3' })).ok).toBe(false);
    expect(validateEntry(validInput({ domain: 'ctf' })).ok).toBe(true);
    expect(validateEntry(validInput({ domain: 42 })).ok).toBe(false);
  });

  it.each(['title', 'applicability', 'content', 'criteria'] as const)('%s 必填非空', (field) => {
    for (const v of [undefined, '', '   ', 123]) {
      const r = validateEntry(validInput({ [field]: v }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.join()).toContain(`${field} 必填且非空`);
    }
  });

  it('provenance 闭集：builtin/user/promoted 通过，其他拒绝', () => {
    for (const p of EXPERT_PROVENANCES) {
      const r = validateEntry(validInput({ provenance: p, reviewer: p === 'builtin' ? undefined : 'bob' }));
      expect(r.ok).toBe(true);
    }
    const bad = validateEntry(validInput({ provenance: 'agent' }));
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors.join()).toContain('provenance 非法');
  });

  it('reviewer 条件必填：provenance≠builtin 且 reviewer 空 → 拒', () => {
    for (const p of ['user', 'promoted'] as const) {
      const r = validateEntry(validInput({ provenance: p, reviewer: undefined }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.join()).toContain('reviewer 必填');
      const r2 = validateEntry(validInput({ provenance: p, reviewer: '  ' }));
      expect(r2.ok).toBe(false);
    }
  });

  it('reviewer 条件必填：builtin 可空', () => {
    const r = validateEntry(validInput({ provenance: 'builtin', reviewer: undefined }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.reviewer).toBeNull();
  });

  it('reviewer 提供时必须非空字符串', () => {
    const r = validateEntry(validInput({ provenance: 'builtin', reviewer: 7 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain('reviewer 提供时必须是非空字符串');
  });

  it('skipReviewer（草稿通道）：user + 空 reviewer 放行', () => {
    const r = validateEntry(validInput({ reviewer: undefined }), { skipReviewer: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.reviewer).toBeNull();
  });

  it('sourceEventId：正整数通过，非整数/负数/字符串拒绝', () => {
    expect(validateEntry(validInput({ sourceEventId: 12 })).ok).toBe(true);
    expect(validateEntry(validInput({ sourceEventId: 0 })).ok).toBe(false);
    expect(validateEntry(validInput({ sourceEventId: 1.5 })).ok).toBe(false);
    expect(validateEntry(validInput({ sourceEventId: '12' })).ok).toBe(false);
  });

  it('tags/enabled 类型错误拒绝', () => {
    expect(validateEntry(validInput({ tags: ['a'] })).ok).toBe(false);
    expect(validateEntry(validInput({ enabled: 'yes' })).ok).toBe(false);
    expect(validateEntry(validInput({ enabled: false })).ok).toBe(true);
  });

  it('多错误一次列全（不遇错即停）', () => {
    const r = validateEntry({ domain: 'x', kind: 'y' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.length).toBeGreaterThanOrEqual(6); // domain/kind/title/applicability/content/criteria/provenance
  });

  it('枚举谓词', () => {
    expect(isExpertEntryKind('sop')).toBe(true);
    expect(isExpertEntryKind('nope')).toBe(false);
    expect(isExpertProvenance('promoted')).toBe(true);
    expect(isExpertProvenance('auto')).toBe(false);
  });
});

describe('computeContentHash', () => {
  it('同内容同 hash；任一内容字段变 → hash 变', () => {
    const base = validateEntry(validInput({ provenance: 'builtin', reviewer: undefined }));
    if (!base.ok) throw new Error('unreachable');
    const h1 = computeContentHash(base.value);
    expect(computeContentHash(base.value)).toBe(h1);
    expect(computeContentHash({ ...base.value, content: '改过' })).not.toBe(h1);
    expect(computeContentHash({ ...base.value, title: '改过' })).not.toBe(h1);
    // reviewer/enabled 是审定元数据，不参与内容指纹
    expect(computeContentHash({ ...base.value, reviewer: 'someone', enabled: false })).toBe(h1);
  });
});
