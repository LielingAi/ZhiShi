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
      } else if (req.url === '/api/admin/environment/discover') {
        // 1.5.10 发现面契约：docker 容器 / docker 镜像（docker-image 驱动）/ VM 三区。
        res.end(JSON.stringify({
          success: true,
          data: {
            docker: [{ id: 'abc123', name: 'zhishi-env-pwn-1', image: 'zhishi-env-pwn:latest', status: 'Up 2 hours', managed: true }],
            images: [
              { driver: 'docker-image', id: 'zhishi-env-pwn:latest', name: 'zhishi-env-pwn:latest', image: 'zhishi-env-pwn:latest', recipeId: 'pwn' },
              { driver: 'docker-image', id: 'zhishi-env-fuzz:latest', name: 'zhishi-env-fuzz:latest', image: 'zhishi-env-fuzz:latest', recipeId: 'fuzz' },
            ],
            vm: [{ driver: 'vmware', id: '/vms/pwn.vmx', name: 'pwn.vmx', vmx: '/vms/pwn.vmx', state: 'unknown', osFamily: 'linux' }],
          },
        }));
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

describe('1.5.10 一致性：env add 新旗标透传 + env bind-recipes 路由/载荷', () => {
  it('env add --recipe-ids a,b --os-family windows --vmx X.vmx 透传为 recipeIds 数组/osFamily/vmx', async () => {
    captured = [];
    const r = await runCli([
      'env', 'add', '--kind', 'vm', '--id', 'win-box', '--vm-name', 'win10',
      '--recipe-ids', 'pwn-vm, fuzz-vm', '--os-family', 'windows', '--vmx', 'C:\\VMs\\win10\\win10.vmx',
    ]);
    expect(r.stderr).not.toContain('ECONNREFUSED');
    expect(r.code).toBe(0);
    const addReq = captured.find((c) => c.url === '/api/admin/environment/add');
    expect(addReq).toBeDefined();
    expect(addReq!.body.recipeIds).toEqual(['pwn-vm', 'fuzz-vm']);
    expect(addReq!.body.osFamily).toBe('windows');
    expect(addReq!.body.vmx).toBe('C:\\VMs\\win10\\win10.vmx');
  }, 30_000);

  it('env add 不带新旗标时请求体不含 recipeIds/osFamily/vmx 键（undefined 不进 JSON）', async () => {
    captured = [];
    const r = await runCli(['env', 'add', '--kind', 'ssh', '--id', 'dev', '--host', '10.0.0.8']);
    expect(r.code).toBe(0);
    const addReq = captured.find((c) => c.url === '/api/admin/environment/add');
    expect(addReq).toBeDefined();
    expect(addReq!.body).not.toHaveProperty('recipeIds');
    expect(addReq!.body).not.toHaveProperty('osFamily');
    expect(addReq!.body).not.toHaveProperty('vmx');
  }, 30_000);

  it('env bind-recipes <id> --recipes a,b,c → /api/admin/environment/bind-recipes { id, recipeIds }', async () => {
    captured = [];
    const r = await runCli(['env', 'bind-recipes', 'dev-box', '--recipes', 'pwn, fuzz, dev']);
    expect(r.stderr).not.toContain('ECONNREFUSED');
    expect(r.code).toBe(0);
    const req = captured.find((c) => c.url === '/api/admin/environment/bind-recipes');
    expect(req).toBeDefined();
    expect(req!.body.id).toBe('dev-box');
    expect(req!.body.recipeIds).toEqual(['pwn', 'fuzz', 'dev']);
  }, 30_000);

  it('env bind-recipes 缺 <id> → 用法报错且不发请求', async () => {
    captured = [];
    const r = await runCli(['env', 'bind-recipes', '--recipes', 'pwn']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('env-id');
    expect(captured.some((c) => c.url === '/api/admin/environment/bind-recipes')).toBe(false);
  }, 30_000);
});

describe('1.5.10：env rebuild/reset 路由与载荷 + env discover 镜像区打印', () => {
  it('env rebuild <recipe> → /api/admin/environment/rebuild { recipe, workspace=cwd }', async () => {
    captured = [];
    const r = await runCli(['env', 'rebuild', 'pwn']);
    expect(r.stderr).not.toContain('ECONNREFUSED');
    expect(r.code).toBe(0);
    const req = captured.find((c) => c.url === '/api/admin/environment/rebuild');
    expect(req).toBeDefined();
    expect(req!.body.recipe).toBe('pwn');
    expect(req!.body.workspace).toBe(process.cwd());
  }, 30_000);

  it('env rebuild 缺 <recipe> → 用法报错且不发请求', async () => {
    captured = [];
    const r = await runCli(['env', 'rebuild']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('recipe');
    expect(captured.some((c) => c.url === '/api/admin/environment/rebuild')).toBe(false);
  }, 30_000);

  it('env reset <id> → /api/admin/environment/reset { id }（无 --cwd 不带 workspace 键）', async () => {
    captured = [];
    const r = await runCli(['env', 'reset', 'pwn-box']);
    expect(r.stderr).not.toContain('ECONNREFUSED');
    expect(r.code).toBe(0);
    const req = captured.find((c) => c.url === '/api/admin/environment/reset');
    expect(req).toBeDefined();
    expect(req!.body.id).toBe('pwn-box');
    expect(req!.body).not.toHaveProperty('workspace');
  }, 30_000);

  it('env reset <id> --cwd /work → 请求体带 workspace=/work', async () => {
    captured = [];
    const r = await runCli(['env', 'reset', 'pwn-box', '--cwd', '/work']);
    expect(r.code).toBe(0);
    const req = captured.find((c) => c.url === '/api/admin/environment/reset');
    expect(req).toBeDefined();
    expect(req!.body.workspace).toBe('/work');
  }, 30_000);

  it('env reset 缺 <id> → 用法报错且不发请求', async () => {
    captured = [];
    const r = await runCli(['env', 'reset']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('env-id');
    expect(captured.some((c) => c.url === '/api/admin/environment/reset')).toBe(false);
  }, 30_000);

  it('env discover 打印含镜像区（逐行 recipeId + 镜像名）及 docker/VM 区', async () => {
    const r = await runCli(['env', 'discover']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('docker 镜像（zhishi-env-*）:');
    expect(r.stdout).toContain('pwn  zhishi-env-pwn:latest');
    expect(r.stdout).toContain('fuzz  zhishi-env-fuzz:latest');
    expect(r.stdout).toContain('docker 容器（仅展示');
    expect(r.stdout).toContain('VM:');
  }, 30_000);

  it('env discover --json：原样输出完整 JSON（含 images 数组），不走分区打印', async () => {
    const r = await runCli(['env', 'discover', '--json']);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain('docker 镜像（zhishi-env-*）:');
    const parsed = JSON.parse(r.stdout) as { success: boolean; data: { images: Array<{ recipeId: string; driver: string }> } };
    expect(parsed.success).toBe(true);
    expect(parsed.data.images.map((i) => i.recipeId)).toEqual(['pwn', 'fuzz']);
    expect(parsed.data.images[0].driver).toBe('docker-image');
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
