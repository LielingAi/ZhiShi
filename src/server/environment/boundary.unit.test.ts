/**
 * 安全研究员版 P1 E6 — D14 边界分类（classifyBoundary）unit tests.
 *
 * 全规则覆盖：界内（env≠host 终端 IO）、控制面命令（docker exec/ssh/…）、
 * 样本宿主执行硬闸（含 Windows 分隔符 / samples 大小写 / cmd 调用）、
 * 越界写（重定向 + cp/mv/del 目标在工作区外）、宿主工作区内操作回落。
 */
import { describe, expect, it } from 'vitest';

import {
  classifyBoundary,
  isOutsideWorkspace,
  MALWARE_HOST_EXEC_DENY_MESSAGE,
  type BoundaryContext,
  type TerminalEnvLookup,
} from './boundary';

const WORKSPACE = 'E:\\code\\u-disk';

function ctxWith(tags: Record<string, string>, workspacePath = WORKSPACE): BoundaryContext {
  const envLookup: TerminalEnvLookup = (id) => tags[id];
  return { envLookup, workspacePath };
}

const NO_ENV = ctxWith({});

function bash(command: string): unknown {
  return { command };
}

describe('classifyBoundary — zhishi term IO（界内）', () => {
  const ctx = ctxWith({ 'ai-1': 'docker:svc', 'ai-2': 'host', 'ai-3': 'vm:win10', 'ai-4': 'range:10.0.0.8' });

  it('term write 指向 env≠host 终端 → in-env', () => {
    expect(classifyBoundary('Bash', bash('zhishi term write ai-1 whoami\\n'), ctx)).toBe('in-env');
    expect(classifyBoundary('Bash', bash('zhishi term write ai-3 "dir\\n"'), ctx)).toBe('in-env');
    expect(classifyBoundary('Bash', bash('zhishi term write ai-4 id\\n'), ctx)).toBe('in-env');
  });

  it('term read 指向 env≠host 终端 → in-env', () => {
    expect(classifyBoundary('Bash', bash('zhishi term read ai-1'), ctx)).toBe('in-env');
  });

  it('term write 指向 host 标记终端 → host-workspace（等同宿主操作）', () => {
    expect(classifyBoundary('Bash', bash('zhishi term write ai-2 whoami\\n'), ctx)).toBe('host-workspace');
  });

  it('term write 指向未知终端（映射丢失）→ host-workspace（保守）', () => {
    expect(classifyBoundary('Bash', bash('zhishi term write ai-999 whoami\\n'), ctx)).toBe('host-workspace');
  });
});

describe('classifyBoundary — 控制面命令', () => {
  it.each([
    'docker exec -it svc bash',
    'docker exec svc id',
    'docker run --rm -it image sh',
    'docker.exe exec svc id',
    'ssh user@10.0.0.8',
    'scp file user@host:/tmp/',
    'sftp user@host',
    'VBoxManage controlvm win10 poweroff',
    'vmrun -T ws start /vm/win10.vmx',
    'virsh console win10',
    'Get-VM -Name win10',
    'GET-VM',
  ])('%s → control-plane', (command) => {
    expect(classifyBoundary('Bash', bash(command), NO_ENV)).toBe('control-plane');
  });

  it.each([
    'docker ps',
    'docker images',
    'docker build .',
    'git status',
    'sshuttle -r host 0/0', // 前缀不是 ssh 单词边界
  ])('%s → 非 control-plane', (command) => {
    expect(classifyBoundary('Bash', bash(command), NO_ENV)).not.toBe('control-plane');
  });
});

describe('classifyBoundary — 样本宿主执行硬闸', () => {
  it.each([
    './samples/mal.exe',
    'samples\\mal.exe',
    '.\\samples\\mal.exe',
    'samples/mal.exe --arg',
    './SAMPLES/MAL.EXE',
    'Samples\\evil.ps1',
    'C:\\lab\\samples\\evil.exe',
    '/tmp/samples/evil',
    'cmd /c samples\\mal.exe',
    'cmd.exe /c "samples\\mal.exe"',
    'CMD /C ./samples/mal.exe',
    'cd samples && ..\\samples\\mal.exe',
  ])('%s → malware-host-exec', (command) => {
    expect(classifyBoundary('Bash', bash(command), NO_ENV)).toBe('malware-host-exec');
  });

  it.each([
    'cat samples/readme.txt',       // 读样本目录 ≠ 执行
    'ls samples/',
    'file samples/mal.exe',
    'sha256sum samples/mal.exe',
    'python analyze.py samples/mal.exe', // 分析工具读样本路径
    'echo samples',
    'cd samples',
  ])('%s → 非硬闸', (command) => {
    expect(classifyBoundary('Bash', bash(command), NO_ENV)).not.toBe('malware-host-exec');
  });

  it('硬拒消息提示进隔离环境', () => {
    expect(MALWARE_HOST_EXEC_DENY_MESSAGE).toContain('隔离环境');
    expect(MALWARE_HOST_EXEC_DENY_MESSAGE).toContain('samples');
  });
});

describe('classifyBoundary — 越界写（cross-boundary）', () => {
  it('重定向到工作区外绝对路径 → cross-boundary', () => {
    expect(classifyBoundary('Bash', bash('echo x > C:\\other\\f.txt'), NO_ENV)).toBe('cross-boundary');
    expect(classifyBoundary('Bash', bash('echo x >> /etc/hosts'), NO_ENV)).toBe('cross-boundary');
    expect(classifyBoundary('Bash', bash('echo x > "D:\\out\\f.txt"'), NO_ENV)).toBe('cross-boundary');
  });

  it('重定向到工作区内 → host-workspace', () => {
    expect(classifyBoundary('Bash', bash('echo x > out.txt'), NO_ENV)).toBe('host-workspace');
    expect(classifyBoundary('Bash', bash('echo x > sub\\out.txt'), NO_ENV)).toBe('host-workspace');
    expect(classifyBoundary('Bash', bash('echo x > E:\\code\\u-disk\\out.txt'), NO_ENV)).toBe('host-workspace');
    expect(classifyBoundary('Bash', bash('echo x > e:/code/u-disk/out.txt'), NO_ENV)).toBe('host-workspace');
  });

  it('stderr 重定向不算越界（/dev/null、2>&1）', () => {
    expect(classifyBoundary('Bash', bash('cmd 2>/dev/null'), NO_ENV)).toBe('host-workspace');
    expect(classifyBoundary('Bash', bash('cmd 2>&1'), NO_ENV)).toBe('host-workspace');
  });

  it('cp/mv/del 目标在工作区外 → cross-boundary', () => {
    expect(classifyBoundary('Bash', bash('cp a.txt D:\\dst\\'), NO_ENV)).toBe('cross-boundary');
    expect(classifyBoundary('Bash', bash('mv a.txt /tmp/x'), NO_ENV)).toBe('cross-boundary');
    expect(classifyBoundary('Bash', bash('del C:\\Windows\\Temp\\x.tmp'), NO_ENV)).toBe('cross-boundary');
    expect(classifyBoundary('Bash', bash('copy a.txt D:\\dst\\'), NO_ENV)).toBe('cross-boundary');
    expect(classifyBoundary('Bash', bash('Remove-Item C:\\outside\\x'), NO_ENV)).toBe('cross-boundary');
  });

  it('cp/mv/del 目标在工作区内 → host-workspace', () => {
    expect(classifyBoundary('Bash', bash('cp a.txt b.txt'), NO_ENV)).toBe('host-workspace');
    expect(classifyBoundary('Bash', bash('mv sub\\a.txt sub2\\'), NO_ENV)).toBe('host-workspace');
    expect(classifyBoundary('Bash', bash('del tmp\\x.tmp'), NO_ENV)).toBe('host-workspace');
  });

  it('Write/Edit 工具写工作区外 → cross-boundary', () => {
    expect(classifyBoundary('Write', { file_path: 'C:\\other\\f.txt' }, NO_ENV)).toBe('cross-boundary');
    expect(classifyBoundary('Edit', { file_path: '/etc/hosts' }, NO_ENV)).toBe('cross-boundary');
  });

  it('Write/Edit 工具写工作区内 → host-workspace', () => {
    expect(classifyBoundary('Write', { file_path: 'E:\\code\\u-disk\\src\\a.ts' }, NO_ENV)).toBe('host-workspace');
    expect(classifyBoundary('Edit', { file_path: 'src/a.ts' }, NO_ENV)).toBe('host-workspace');
  });
});

describe('classifyBoundary — 其余回落', () => {
  it('非 Bash/写工具 → host-workspace', () => {
    expect(classifyBoundary('Read', { file_path: '/etc/hosts' }, NO_ENV)).toBe('host-workspace');
    expect(classifyBoundary('mcp__x__y', {}, NO_ENV)).toBe('host-workspace');
    expect(classifyBoundary('WebFetch', { url: 'https://x' }, NO_ENV)).toBe('host-workspace');
  });

  it('普通宿主命令 → host-workspace', () => {
    expect(classifyBoundary('Bash', bash('npm test'), NO_ENV)).toBe('host-workspace');
    expect(classifyBoundary('Bash', bash(''), NO_ENV)).toBe('host-workspace');
  });
});

describe('isOutsideWorkspace', () => {
  it('相对路径不算越界', () => {
    expect(isOutsideWorkspace('out.txt', WORKSPACE)).toBe(false);
    expect(isOutsideWorkspace('sub\\out.txt', WORKSPACE)).toBe(false);
  });

  it('工作区内绝对路径（含大小写/分隔符变体）不算越界', () => {
    expect(isOutsideWorkspace('E:\\code\\u-disk\\a.txt', WORKSPACE)).toBe(false);
    expect(isOutsideWorkspace('e:/code/u-disk/a.txt', WORKSPACE)).toBe(false);
    expect(isOutsideWorkspace('E:/code/u-disk', WORKSPACE)).toBe(false);
  });

  it('工作区外绝对路径（盘符/UNC/POSIX）算越界', () => {
    expect(isOutsideWorkspace('E:\\code\\other\\a.txt', WORKSPACE)).toBe(true);
    expect(isOutsideWorkspace('C:\\a.txt', WORKSPACE)).toBe(true);
    expect(isOutsideWorkspace('\\\\nas\\share\\a.txt', WORKSPACE)).toBe(true);
    expect(isOutsideWorkspace('/tmp/a.txt', WORKSPACE)).toBe(true);
  });

  it('前缀陷阱：u-disk2 不算工作区内', () => {
    expect(isOutsideWorkspace('E:\\code\\u-disk2\\a.txt', WORKSPACE)).toBe(true);
  });

  it('空工作区上下文不臆断', () => {
    expect(isOutsideWorkspace('C:\\a.txt', '')).toBe(false);
  });
});
