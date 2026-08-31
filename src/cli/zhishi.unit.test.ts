/**
 * zhishi.ts CLI 端到端回归（1.5.4 审计）——真 spawn CLI 子进程 + 本地 mock
 * admin server（127.0.0.1 ephemeral 端口），验证两个 CLI 边界行为：
 *  - A1-4：`env add --kind ssh --port N` 的 --port 是目标主机端口（进请求体），
 *    不再被全局 sidecar 端口覆盖抢走（修复前该用法必然 ECONNREFUSED）；
 *  - A2-9：`expert review --json` 在非 TTY（管道 stdin）下输出 JSON 形态，
 *    不混人类可读的草稿行/用法提示。
 * spawn 开销约 1s/次（node --import tsx），单测超时放到 30s 兜底 Windows CI。
 */
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('zhishi.ts', import.meta.url));

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

const DRAFT = {
  id: 1,
  domain: 'binary',
  kind: 'sop',
  title: 'fastbin dup 三板斧',
  createdVia: 'agent',
  createdAt: 1720000000000,
};

let server: Server;
let port = 0;
let captured: CapturedRequest[] = [];

function runCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], {
      // stdin 走管道 → 子进程 isTTY=undefined，正好覆盖「非 TTY」路径。
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ZHISHI_PORT: String(port), ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end();
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += String(c)));
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        /* 非 JSON body 按空处理——本测试只关心路由命中与字段透传 */
      }
      captured.push({ url: req.url ?? '', body });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/admin/expert/drafts') {
        res.end(JSON.stringify({ success: true, data: { drafts: [DRAFT] } }));
      } else {
        res.end(JSON.stringify({ success: true, data: {} }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('mock server 未拿到 ephemeral 端口');
  port = addr.port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('A1-4 回归：env add --port 是 ssh 目标端口，不覆盖 sidecar 端口', () => {
  it('env add --kind ssh --port 2222 命中 mock sidecar 且请求体 port=2222', async () => {
    captured = [];
    const r = await runCli(['env', 'add', '--kind', 'ssh', '--id', 'dev', '--host', '10.0.0.8', '--port', '2222']);
    expect(r.stderr).not.toContain('ECONNREFUSED');
    expect(r.code).toBe(0);
    const addReq = captured.find((c) => c.url === '/api/admin/environment/add');
    expect(addReq).toBeDefined();
    expect(addReq!.body.port).toBe('2222');
  }, 30_000);

  it('对照组：其余命令的全局 --port 覆盖仍然生效（status --port 覆盖错误的 ZHISHI_PORT）', async () => {
    captured = [];
    const r = await runCli(['status', '--port', String(port)], { ZHISHI_PORT: '1' });
    expect(r.code).toBe(0);
    expect(captured.some((c) => c.url === '/api/admin/status')).toBe(true);
  }, 30_000);
});

describe('A2-9 回归：expert review --json 在非 TTY 下尊重 jsonMode', () => {
  it('--json：stdout 是可解析 JSON（含 drafts），无人类提示行', async () => {
    const r = await runCli(['expert', 'review', '--json']);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain('非交互用法');
    const parsed = JSON.parse(r.stdout) as { success: boolean; data: { drafts: Array<{ id: number }> } };
    expect(parsed.success).toBe(true);
    expect(parsed.data.drafts.map((d) => d.id)).toEqual([1]);
  }, 30_000);

  it('对照组：无 --json 时仍打印人类格式草稿行 + 非交互用法提示', async () => {
    const r = await runCli(['expert', 'review']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('#1');
    expect(r.stdout).toContain('非交互用法');
  }, 30_000);
});
