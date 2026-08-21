/**
 * expert-edit（CLI 编辑器往返）单元测试（1.2.1 骨架期）。
 *
 * 纯函数部分：buildExpertDoc / parseExpertDoc / resolveEditorCommand。
 * 往返循环：runEditor / confirmRetry / tmpDir / log 全注入——不起真实编辑器、
 * 不碰真实终端；校验用服务端同款单点 validateEntry（口径一致性顺便验证）。
 *
 * 覆盖：模板预填/注释引导、解析错误面（缺 frontmatter / 坏 YAML / 非对象）、
 * CRLF 归一、编辑器退出码非零与文件未动不落库、校验失败重试决策、
 * 启动失败不可重试、临时文件任何出口清理。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildExpertDoc,
  expertEditRoundTrip,
  parseExpertDoc,
  resolveEditorCommand,
  type ExpertEditorDeps,
} from './expert-edit';
import { validateEntry, type ValidateResult } from '../server/expert/validate';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zhishi-expertedit-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const VALID_FIELDS = {
  domain: 'binary',
  kind: 'technique',
  title: '栈溢出 triage',
  applicability: '拿到崩溃现场',
  criteria: '判据',
  reviewer: 'alice',
  tags: 'pwn, stack',
};

/** 用服务端单点校验组装 validate 回调（provenance 通道固定 user）。 */
function validateAsUser(raw: string): ValidateResult {
  const parsed = parseExpertDoc(raw);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  return validateEntry({ ...parsed.fields, content: parsed.content, provenance: 'user' });
}

/** 注入式 deps：runEditor 每次把 filePath 记下，按需改写文件内容。 */
function makeDeps(opts: {
  edits?: Array<string | undefined>; // 第 N 次编辑器开启后文件变成 edits[N-1]（不改写 = 不动文件）
  exitCodes?: number[];
  spawnError?: string;
  retryAnswers?: boolean[];
}) {
  const state = { filePath: '', calls: 0, logs: [] as string[] };
  const deps: ExpertEditorDeps = {
    tmpDir: dir,
    log: (m) => state.logs.push(m),
    runEditor: (_argv, filePath) => {
      state.filePath = filePath;
      const n = state.calls;
      state.calls += 1;
      if (opts.spawnError) return { code: 1, spawnError: opts.spawnError };
      const code = opts.exitCodes?.[n] ?? 0;
      if (code === 0 && opts.edits?.[n] !== undefined) writeFileSync(filePath, opts.edits[n], 'utf-8');
      return { code };
    },
    confirmRetry: async () => opts.retryAnswers?.shift() ?? false,
  };
  return { state, deps };
}

describe('buildExpertDoc / parseExpertDoc 往返', () => {
  it('模板含全字段注释引导 + 预填 title；解析还原字段与正文', () => {
    const doc = buildExpertDoc({ title: 'fastbin dup 利用' }, '');
    expect(doc.startsWith('---\n')).toBe(true);
    expect(doc).toContain('# domain 必填，闭集：binary / pentest / ai-security');
    expect(doc).toContain('# kind 必填，闭集：idea / technique / sop');
    expect(doc).toContain('title: fastbin dup 利用');
    expect(doc).toContain('# reviewer 必填非空');

    const parsed = parseExpertDoc(doc);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.fields.title).toBe('fastbin dup 利用');
      expect(parsed.fields.domain).toBe(''); // 空占位 → 交给 validateEntry 判必填
      expect(parsed.content).toContain('在此写正文');
    }
  });

  it('全字段预填（edit/promote 导出）→ 解析等值往返；特殊字符 title 正确转义', () => {
    const doc = buildExpertDoc({ ...VALID_FIELDS, title: '含: 冒号 "引号" 的标题' }, '## 正文\n内容行');
    const parsed = parseExpertDoc(doc);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.fields.title).toBe('含: 冒号 "引号" 的标题');
      expect(parsed.fields.domain).toBe('binary');
      expect(parsed.fields.tags).toBe('pwn, stack');
      expect(parsed.content.trim()).toBe('## 正文\n内容行');
    }
    // 与服务端单点校验口径一致：预填全字段直接过
    if (parsed.ok) {
      const v = validateEntry({ ...parsed.fields, content: parsed.content, provenance: 'user' });
      expect(v.ok).toBe(true);
    }
  });

  it('解析错误面：缺 frontmatter / 坏 YAML / 非对象 frontmatter', () => {
    const noFm = parseExpertDoc('只有正文，没有头部');
    expect(noFm.ok).toBe(false);
    if (!noFm.ok) expect(noFm.errors[0]).toContain('缺少 frontmatter');

    const badYaml = parseExpertDoc('---\ndomain: [未闭合\n---\n正文');
    expect(badYaml.ok).toBe(false);
    if (!badYaml.ok) expect(badYaml.errors[0]).toContain('YAML 解析失败');

    const nonObject = parseExpertDoc('---\n- 数组\n- 不是对象\n---\n正文');
    expect(nonObject.ok).toBe(false);
    if (!nonObject.ok) expect(nonObject.errors[0]).toContain('YAML 对象');
  });

  it('CRLF 归一为 LF', () => {
    const parsed = parseExpertDoc('---\r\ntitle: x\r\n---\r\n\r\n正文\r\n第二行\r\n');
    expect(parsed.ok).toBe(true);
    // frontmatter 结束符后的空行属正文（解析保真，trim 由 validateEntry 负责）
    if (parsed.ok) expect(parsed.content).toBe('\n正文\n第二行\n');
  });
});

describe('resolveEditorCommand', () => {
  it('EDITOR 优先于 VISUAL；缺省 win32=notepad / 其他=vi；带参数按空白切分', () => {
    expect(resolveEditorCommand({ EDITOR: 'code --wait' }, 'linux')).toEqual(['code', '--wait']);
    expect(resolveEditorCommand({ VISUAL: 'nano' }, 'linux')).toEqual(['nano']);
    expect(resolveEditorCommand({ EDITOR: '  ', VISUAL: 'nano' }, 'linux')).toEqual(['nano']);
    expect(resolveEditorCommand({}, 'win32')).toEqual(['notepad']);
    expect(resolveEditorCommand({}, 'darwin')).toEqual(['vi']);
  });
});

describe('expertEditRoundTrip（注入编辑器）', () => {
  it('文件未动 → aborted，不给 ok（不落库）；临时文件已清理', async () => {
    const initial = buildExpertDoc(VALID_FIELDS, '正文');
    const { state, deps } = makeDeps({ edits: [] });
    const r = await expertEditRoundTrip(initial, validateAsUser, deps);
    expect(r.status).toBe('aborted');
    if (r.status === 'aborted') expect(r.reason).toContain('未修改');
    expect(existsSync(state.filePath)).toBe(false);
  });

  it('编辑成合法内容 → ok；validate 收到服务端同款校验通过的内容', async () => {
    const initial = buildExpertDoc({ title: 'x' }, '');
    const edited = buildExpertDoc(VALID_FIELDS, '## 经验\n正文');
    const { deps } = makeDeps({ edits: [edited] });
    const r = await expertEditRoundTrip(initial, validateAsUser, deps);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      const v = validateAsUser(r.raw);
      expect(v.ok).toBe(true);
      if (v.ok) expect(v.value.reviewer).toBe('alice');
    }
  });

  it('非法 → 列全部错误；confirmRetry=false → aborted；=true → 带用户内容重开至合法', async () => {
    const initial = buildExpertDoc({ title: 'x' }, '');
    // 第一轮：只填了 domain（缺 kind/applicability/...）；第二轮：补全
    const halfDone = buildExpertDoc({ domain: 'binary', title: 'x' }, '正文');
    const full = buildExpertDoc(VALID_FIELDS, '正文');
    const { state, deps } = makeDeps({ edits: [halfDone, full], retryAnswers: [true] });
    const r = await expertEditRoundTrip(initial, validateAsUser, deps);
    expect(r.status).toBe('ok');
    expect(state.calls).toBe(2);
    // 错误列全（kind/applicability/criteria/reviewer 都应出现）
    const errLog = state.logs.join('\n');
    expect(errLog).toContain('校验未通过');
    expect(errLog).toContain('kind 非法');
    expect(errLog).toContain('reviewer 必填');

    // confirmRetry=false → 放弃
    const giveUp = makeDeps({ edits: [halfDone], retryAnswers: [false] });
    const r2 = await expertEditRoundTrip(initial, validateAsUser, giveUp.deps);
    expect(r2.status).toBe('aborted');
    if (r2.status === 'aborted') expect(r2.reason).toContain('校验未通过');
  });

  it('退出码非零 → confirmRetry 决策（false=放弃，true=重开）；spawnError 不可重试直接 aborted', async () => {
    const initial = buildExpertDoc({ title: 'x' }, '');
    const noRetry = makeDeps({ exitCodes: [1], retryAnswers: [false] });
    const r1 = await expertEditRoundTrip(initial, validateAsUser, noRetry.deps);
    expect(r1.status).toBe('aborted');
    if (r1.status === 'aborted') expect(r1.reason).toContain('退出码非零');

    const edited = buildExpertDoc(VALID_FIELDS, '正文');
    const retry = makeDeps({ exitCodes: [1, 0], edits: [undefined, edited], retryAnswers: [true] });
    const r2 = await expertEditRoundTrip(initial, validateAsUser, retry.deps);
    expect(r2.status).toBe('ok');

    const spawnFail = makeDeps({ spawnError: 'spawn notepad ENOENT', retryAnswers: [true] });
    const r3 = await expertEditRoundTrip(initial, validateAsUser, spawnFail.deps);
    expect(r3.status).toBe('aborted');
    if (r3.status === 'aborted') expect(r3.reason).toContain('编辑器启动失败');
    expect(spawnFail.state.calls).toBe(1); // 不重试
  });

  it('Windows 编辑器写回 CRLF → 归一后校验不受影响', async () => {
    const initial = buildExpertDoc({ title: 'x' }, '');
    const edited = buildExpertDoc(VALID_FIELDS, '正文').replace(/\n/g, '\r\n');
    const { deps } = makeDeps({ edits: [edited] });
    const r = await expertEditRoundTrip(initial, validateAsUser, deps);
    expect(r.status).toBe('ok');
  });
});
