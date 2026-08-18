/**
 * bg-exec unit tests — tag 校验、远端命令组装、stdout 解析、编排
 * (注入 exec,绝不真起 ssh/docker)。
 */

import { describe, it, expect } from 'vitest';
import type { EnvironmentEntry } from '../../shared/config-types';
import type { EnvExec, EnvExecProcessResult } from './env-exec';
import {
  BG_DIR,
  BG_DIR_WIN,
  buildBgKillRemote,
  buildBgListRemote,
  buildBgLogRemote,
  buildBgPollRemote,
  buildBgStartRemote,
  envBgKill,
  envBgList,
  envBgLog,
  envBgPoll,
  envBgStart,
  parseBgList,
  parseBgLog,
  parseBgPoll,
  parseBgStart,
  validateTag,
} from './bg-exec';

const DOCKER: EnvironmentEntry = { id: 'd', kind: 'docker', container: 'c1', createdAt: '' };

function scriptedExec(results: Array<string | EnvExecProcessResult>): { exec: EnvExec; calls: string[][] } {
  const calls: string[][] = [];
  let i = 0;
  const exec: EnvExec = async (argv) => {
    calls.push([...argv]);
    const r = results[i++] ?? { exitCode: 0, stdout: '', stderr: '' };
    return typeof r === 'string' ? { exitCode: 0, stdout: r, stderr: '' } : r;
  };
  return { exec, calls };
}

describe('validateTag', () => {
  it('白名单 [A-Za-z0-9_-]{1,64};注入/路径/空 → 拒绝', () => {
    expect(validateTag('fuzz-1')).toBeUndefined();
    expect(validateTag('a_b-c9')).toBeUndefined();
    expect(validateTag('../etc')).toBeDefined();
    expect(validateTag('a; rm -rf')).toBeDefined();
    expect(validateTag('a b')).toBeDefined();
    expect(validateTag('')).toBeDefined();
    expect(validateTag('x'.repeat(65))).toBeDefined();
  });
});

describe('远端命令组装', () => {
  it('start:base64 命令 + 落 log/pid/exit + stdin 重定向', () => {
    const remote = buildBgStartRemote('echo hi; echo "q"', 't1');
    expect(remote).toContain(`mkdir -p ${BG_DIR}; `);
    expect(remote).toContain(`< /dev/null > ${BG_DIR}/t1.log 2>&1`);
    expect(remote).toContain(`echo $! > ${BG_DIR}/t1.pid`);
    expect(remote).toContain('base64 -d | sh');
    expect(remote).toContain(`echo $? > ${BG_DIR}/t1.exit`);
    expect(remote).not.toContain('echo hi'); // 命令本身不裸进包装脚本
    expect(remote).not.toContain('cd /tmp/zhishi-bg'); // cd 不再进后台子壳
  });

  it('poll/log/kill/list 形状', () => {
    expect(buildBgPollRemote('t1')).toContain('ps -p');
    expect(buildBgPollRemote('t1')).toContain('exited');
    expect(buildBgLogRemote('t1', 0, 8192)).toContain('tail -c 8192');
    expect(buildBgLogRemote('t1', 100, 8192)).toContain('tail -c +100');
    expect(buildBgKillRemote('t1')).toContain('kill');
    expect(buildBgListRemote()).toContain('*.log');
  });
});

describe('stdout 解析', () => {
  it('poll 四态', () => {
    expect(parseBgPoll('missing', 't')).toEqual({ tag: 't', status: 'missing' });
    expect(parseBgPoll('running:1234', 't')).toEqual({ tag: 't', status: 'running', pid: 1234 });
    expect(parseBgPoll('exited:137', 't')).toEqual({ tag: 't', status: 'exited', exitCode: 137 });
    expect(parseBgPoll('dead:1234', 't')).toEqual({ tag: 't', status: 'dead', pid: 1234 });
  });

  it('start 解析 pid;log 解析 size+text;list 解析 tag 列表', () => {
    expect(parseBgStart('  42 \n')).toEqual({ pid: 42 });
    expect(parseBgStart('garbage')).toEqual({});
    const log = parseBgLog('1234\nhello\nworld\n', 't', 8192);
    expect(log).toEqual({ tag: 't', size: 1234, text: 'hello\nworld\n', truncated: false });
    expect(parseBgList('a\nb\n\n')).toEqual([{ tag: 'a' }, { tag: 'b' }]);
  });
});

describe('Windows 变体(OS 家族分派)', () => {
  it('builders:windows 包装形状(Start-Process/cmd 文件/退出码回写)', () => {
    const s = buildBgStartRemote('echo hi', 't1', 'windows');
    expect(s).toContain('Start-Process');
    expect(s).toContain(`${BG_DIR_WIN}\\t1.cmd`);
    expect(s).not.toContain('echo hi');
    // 退出码回写在编码的 .cmd 体内——解码验证,不裸文断言。
    const m = /\$b='([A-Za-z0-9+/=]+)'/.exec(s);
    expect(m).not.toBeNull();
    const cmdBody = Buffer.from(m![1], 'base64').toString('utf8');
    expect(cmdBody).toContain('echo hi');
    expect(cmdBody).toContain('%ERRORLEVEL%');
    expect(cmdBody).toContain(`${BG_DIR_WIN}\\t1.exit`);
    expect(buildBgPollRemote('t1', 'windows')).toContain('Get-Process');
    expect(buildBgLogRemote('t1', 0, 100, 'windows')).toContain('ReadAllText');
    expect(buildBgKillRemote('t1', 'windows')).toContain('Stop-Process');
    expect(buildBgListRemote('windows')).toContain(BG_DIR_WIN);
  });

  it('编排:windows ssh 条目 → argv 尾参是 powershell -EncodedCommand', async () => {
    const winEntry: EnvironmentEntry = { id: 'w', kind: 'ssh', host: '10.0.0.9', osFamily: 'windows', createdAt: '' };
    const { exec, calls } = scriptedExec(['missing', '  4242\r\n']);
    const r = await envBgStart(winEntry, 'ping -n 3 127.0.0.1', 'w1', { exec });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(2);
    const lastArg = calls[1][calls[1].length - 1];
    expect(lastArg).toContain('powershell');
    expect(lastArg).toContain('-EncodedCommand');
  });
});

describe('编排(注入 exec,薄包)', () => {
  it('start:占用检查 poll(非 running)→ start 返回 pid', async () => {
    const { exec, calls } = scriptedExec(['missing', '  1234\n']);
    const r = await envBgStart(DOCKER, 'seq 1 100', 'run1', { exec });
    expect(r).toEqual({ ok: true, tag: 'run1', pid: 1234, logPath: `${BG_DIR}/run1.log` });
    expect(calls).toHaveLength(2); // poll + start
    expect(calls[0].slice(-1)[0]).toContain('ps -p');
    expect(calls[1].slice(-1)[0]).toContain('base64');
  });

  it('start:tag 已被运行中进程占用 → 拒绝', async () => {
    const { exec } = scriptedExec(['running:9']);
    const r = await envBgStart(DOCKER, 'x', 'busy', { exec });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('占用');
  });

  it('poll 走 execInEnvironment 并解析', async () => {
    const { exec } = scriptedExec(['running:77']);
    const r = await envBgPoll(DOCKER, 't', { exec });
    expect(r).toEqual({ ok: true, tag: 't', status: 'running', pid: 77 });
  });

  it('log/kill/list 编排', async () => {
    const { exec } = scriptedExec(['512\nabc\n', 'killed:1', 'a\nb\n']);
    const log = await envBgLog(DOCKER, 't', 0, 8192, { exec });
    expect(log).toEqual({ ok: true, tag: 't', size: 512, text: 'abc\n', truncated: false });
    const kill = await envBgKill(DOCKER, 't', { exec });
    expect(kill).toEqual({ ok: true, outcome: 'killed:1' });
    const list = await envBgList(DOCKER, { exec });
    expect(list).toEqual({ ok: true, entries: [{ tag: 'a' }, { tag: 'b' }] });
  });

  it('guest 通道(断网 VM)→ 清晰错误(Phase 3 待实现)', async () => {
    const guest: EnvironmentEntry = { id: 'v', kind: 'vm', vmName: 'iso', vmx: 'D:\\v\\iso.vmx', createdAt: '' };
    const { exec } = scriptedExec([]);
    const r = await envBgStart(guest, 'x', 't', { exec });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('guest-exec');
  });
});
