/**
 * remote relay 端到端测试（2.0.3 团队大脑内建中继）。
 *
 * 测的是真实产物 `src-tauri/resources/relay.cjs`：起真实子进程 + 真实
 * loopback socket，验证 Rust 侧依赖的契约——READY 行、双向字节流、
 * 半关闭传播、目标拒绝语义、参数错误退出码。全部绑定 127.0.0.1:0
 * （OS 分配端口），无固定端口、无共享状态，可安全并行（unit 池）。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { connect as createConnection, createServer, type Server, type Socket } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const RELAY_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src-tauri/resources/relay.cjs');
const READY_RE = /^ZHISHI_RELAY_READY (\d{1,5})$/;

const children: ChildProcess[] = [];
const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(() => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const srv of servers.splice(0)) srv.close();
  for (const child of children.splice(0)) child.kill();
});

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'object' && address) resolve(address.port);
      else reject(new Error('no address'));
    });
  });
}

function once<T = unknown>(emitter: { once(ev: string, fn: (v: T) => void): void }, event: string, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`超时等待 ${what}`)), 5000);
    emitter.once(event, (v: T) => {
      clearTimeout(timer);
      resolve(v);
    });
  });
}

/** spawn relay.cjs，读到 READY 行返回监听端口。 */
async function startRelay(argv: string[]): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(process.execPath, [RELAY_SCRIPT, ...argv], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  const stderrChunks: string[] = [];
  child.stderr!.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString()));
  const port = await new Promise<number>((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`relay 未在 5s 内输出 READY 行。stderr: ${stderrChunks.join('')}`));
    }, 5000);
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const line = (buffer.split('\n')[0] ?? '').trim();
      const match = READY_RE.exec(line);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`relay 在 READY 前退出（code=${code}）。stderr: ${stderrChunks.join('')}`));
    });
  });
  return { child, port };
}

function open(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = createConnection({ host: '127.0.0.1', port }, () => {
      // 连接建立后错误经 close 事件观察（断言走 close）——relay 侧 RST
      // 是合法语义（目标拒绝），不期望它冒成 unhandled error。
      s.on('error', () => {});
      resolve(s);
    });
    s.once('error', reject);
    sockets.push(s);
  });
}

describe('remote relay（src-tauri/resources/relay.cjs）', () => {
  it('READY 行 + 双向字节流（echo 往返）', async () => {
    const echo = createServer((s) => {
      s.on('error', () => {});
      s.pipe(s);
    });
    const targetPort = await listen(echo);

    const { port } = await startRelay(['--target-host', '127.0.0.1', '--target-port', String(targetPort)]);

    const client = await open(port);
    client.write('ping');
    const echoed = await once<Buffer>(client, 'data', 'echo 回包');
    expect(echoed.toString()).toBe('ping');
  });

  it('半关闭传播：客户端 FIN → 对端收到 end，回包后正常关闭', async () => {
    const target = createServer((s) => {
      s.on('error', () => {});
      s.on('data', () => s.write('y'));
      s.on('end', () => {
        s.end('bye');
      });
    });
    const targetPort = await listen(target);

    const { port } = await startRelay(['--target-host', '127.0.0.1', '--target-port', String(targetPort)]);

    const client = await open(port);
    client.write('x');
    const first = await once<Buffer>(client, 'data', '首回包');
    expect(first.toString()).toBe('y');

    client.end();
    const second = await once<Buffer>(client, 'data', '半关闭回包');
    expect(second.toString()).toBe('bye');
    await once(client, 'end', '客户端 end');
  });

  it('目标拒绝：连接被立即断开而不是挂起', async () => {
    // 占一个端口再释放，拿到"确定关闭"的端口。
    const probe = createServer();
    const deadPort = await listen(probe);
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    servers.splice(servers.indexOf(probe), 1);

    const { port } = await startRelay(['--target-host', '127.0.0.1', '--target-port', String(deadPort)]);

    const client = await open(port);
    // relay 侧 upstream ECONNREFUSED → destroy 客户端：必收 close，且不挂起。
    await once(client, 'close', '客户端 close');
  });

  it('参数错误：非数字端口 → 退出码 2 + 用法提示', async () => {
    const child = spawn(process.execPath, [RELAY_SCRIPT, '--target-host', '127.0.0.1', '--target-port', 'abc'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    const exitCode = await new Promise<number>((resolve) => child.once('exit', (code) => resolve(code ?? -1)));
    expect(exitCode).toBe(2);
  });

  it('参数错误：缺 target-host → 退出码 2', async () => {
    const child = spawn(process.execPath, [RELAY_SCRIPT, '--target-port', '7411'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    const exitCode = await new Promise<number>((resolve) => child.once('exit', (code) => resolve(code ?? -1)));
    expect(exitCode).toBe(2);
  });
});
