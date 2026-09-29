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
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('zhishi.ts', import.meta.url));

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
  /** 原始请求体（非 JSON 路由——P4 文件上传的裸字节流——断字节用）。 */
  raw: string;
}

const DRAFT = {
  id: 1,
  domain: 'binary',
  kind: 'sop',
  title: 'fastbin dup 三板斧',
  createdVia: 'agent',
  createdAt: 1720000000000,
};

// 1.8.7 P4 get-file 用例的「环境内文件」字节与预期 sha256。
const GET_FILE_BYTES = Buffer.from('remote-poc-bytes-from-env');
const GET_FILE_SHA = createHash('sha256').update(GET_FILE_BYTES).digest('hex');

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
      env: {
        ...process.env,
        // 置空而非删除：防止开发者本机/CI 的 ZHISHI_SERVER/ZHISHI_TOKEN 泄进
        // 子进程让本机模式用例静默变成远端模式（空串在 CLI 侧按未设处理）。
        ZHISHI_SERVER: '',
        ZHISHI_TOKEN: '',
        ZHISHI_PORT: String(port),
        ...env,
      },
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
      captured.push({ url: req.url ?? '', body, headers: req.headers, raw });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/health') {
        // 1.8.7 P0.5 远端模式就绪判据（与 sidecar-ensure 同口径）。
        res.end(JSON.stringify({ ok: true }));
      } else if (req.url === '/refs/aaaa1111') {
        // 1.6.3 refs 消费端：根路径 /refs/:id 取外溢全文（非 /api/admin）。
        res.end(JSON.stringify({ toolUseId: 't1', content: 'BIG-OUTPUT' }));
      } else if (req.url === '/refs/dead0000') {
        // GC/TTL 过期 → 404（large-value-store 契约）。
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'ref not found or expired' }));
      } else if ((req.url ?? '').startsWith('/api/files/upload')) {
        // 1.8.7 P4 文件上传：裸字节流 + query（envId/envPath/name）。
        const q = new URL(req.url ?? '', 'http://mock').searchParams;
        res.end(JSON.stringify({
          success: true,
          data: {
            refId: 'aaaa1111',
            envId: q.get('envId'),
            envPath: q.get('envPath'),
            bytes: Buffer.byteLength(raw),
            sha256: createHash('sha256').update(raw).digest('hex'),
            via: 'docker-cp',
          },
        }));
      } else if (req.url === '/api/admin/environment/extract-file') {
        // 1.8.7 P4 文件下载第一步：回 ref 元信息（字节走 /refs/:id）。
        res.end(JSON.stringify({
          success: true,
          data: { refId: 'dl000001', name: 'out.bin', bytes: GET_FILE_BYTES.length, sha256: GET_FILE_SHA },
        }));
      } else if (req.url === '/refs/dl000001') {
        // 1.8.7 P4 文件下载第二步：流式回原始字节。
        res.setHeader('content-type', 'application/octet-stream');
        res.end(GET_FILE_BYTES);
      } else if (req.url === '/api/admin/config/get') {
        // printResult 深扫用例：响应里嵌 {kind:'ref'} 占位。
        res.end(JSON.stringify({
          success: true,
          data: {
            key: 'k',
            value: { kind: 'ref', id: 'ab12cd34', sizeBytes: 300 * 1024, mimetype: 'application/json', preview: 'HEAD', expiresAt: Date.now() + 3_600_000 },
          },
        }));
      } else if (req.url === '/api/admin/expert/drafts') {
        res.end(JSON.stringify({ success: true, data: { drafts: [DRAFT] } }));
      } else if (req.url === '/api/admin/auth/add') {
        // 1.8.7 P1：secret 只在 add 响应出现一次。
        res.end(JSON.stringify({
          success: true,
          data: { id: 'tok_test01', name: body.name, role: body.role, createdAt: '2026-09-29T00:00:00.000Z', secret: 'zst_mocksecret' },
        }));
      } else if (req.url === '/api/admin/auth/list') {
        res.end(JSON.stringify({
          success: true,
          data: { enabled: true, tokens: [{ id: 'tok_test01', name: 'A', role: 'reviewer', createdAt: '2026-09-29T00:00:00.000Z' }] },
        }));
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

describe('1.6.6：env rename 路由与载荷（别名）', () => {
  it('env rename <id> <名称> → /api/admin/environment/rename { id, name }', async () => {
    captured = [];
    const r = await runCli(['env', 'rename', 'dev-box', '旧靶机']);
    expect(r.stderr).not.toContain('ECONNREFUSED');
    expect(r.code).toBe(0);
    const req = captured.find((c) => c.url === '/api/admin/environment/rename');
    expect(req).toBeDefined();
    expect(req!.body).toEqual({ id: 'dev-box', name: '旧靶机' });
  }, 30_000);

  it('env rename 缺 <id> → 用法报错且不发请求', async () => {
    captured = [];
    const r = await runCli(['env', 'rename']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('env-id');
    expect(captured.some((c) => c.url === '/api/admin/environment/rename')).toBe(false);
  }, 30_000);
});

describe('1.6.4 M0：env push 路由与载荷（传入通道）', () => {
  it('env push <id> <host> <guest> → /api/admin/environment/push { id, hostPath, guestPath, workspace, guestUser? }', async () => {
    captured = [];
    const r = await runCli(['env', 'push', 'win-box', 'C:\\work\\poc.exe', 'C:/target/poc.exe', '--guest-user', 'analyst']);
    expect(r.stderr).not.toContain('ECONNREFUSED');
    expect(r.code).toBe(0);
    const req = captured.find((c) => c.url === '/api/admin/environment/push');
    expect(req).toBeDefined();
    expect(req!.body.id).toBe('win-box');
    expect(req!.body.hostPath).toBe('C:\\work\\poc.exe');
    expect(req!.body.guestPath).toBe('C:/target/poc.exe');
    expect(req!.body.workspace).toBe(process.cwd());
    expect(req!.body.guestUser).toBe('analyst');
  }, 30_000);

  it('env push 缺 <guest-path> → 用法报错且不发请求', async () => {
    captured = [];
    const r = await runCli(['env', 'push', 'win-box', 'C:\\work\\poc.exe']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('guest-path');
    expect(captured.some((c) => c.url === '/api/admin/environment/push')).toBe(false);
  }, 30_000);
});

describe('1.8.7 P4：env put-file / get-file（客户端磁盘 ↔ 服务器侧环境）', () => {
  it('put-file：本地文件裸流 POST /api/files/upload（query + 字节原样 + Content-Length）', async () => {
    captured = [];
    const dir = mkdtempSync(join(tmpdir(), 'zhishi-cli-p4-'));
    try {
      const local = join(dir, 'poc.txt');
      writeFileSync(local, 'poc-upload-0123456789');
      const r = await runCli(['env', 'put-file', 'zhishi-env-pwn-1', local, '/work/poc.txt']);
      expect(r.stderr).not.toContain('ECONNREFUSED');
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('✓');
      expect(r.stdout).toContain('/work/poc.txt');
      const req = captured.find((c) => c.url.startsWith('/api/files/upload'));
      expect(req).toBeDefined();
      const q = new URL(req!.url, 'http://mock').searchParams;
      expect(q.get('envId')).toBe('zhishi-env-pwn-1');
      expect(q.get('envPath')).toBe('/work/poc.txt');
      expect(q.get('name')).toBe('poc.txt');
      expect(req!.raw).toBe('poc-upload-0123456789');
      expect(req!.headers['content-length']).toBe(String('poc-upload-0123456789'.length));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('get-file：extract-file 拿 ref → /refs/:id 流式落盘（sha256 校验过）', async () => {
    captured = [];
    const dir = mkdtempSync(join(tmpdir(), 'zhishi-cli-p4-'));
    try {
      const dest = join(dir, 'out.bin');
      const r = await runCli(['env', 'get-file', 'zhishi-env-pwn-1', '/work/out.bin', dest]);
      expect(r.stderr).not.toContain('ECONNREFUSED');
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('✓');
      expect(r.stdout).toContain('已校验');
      const prep = captured.find((c) => c.url === '/api/admin/environment/extract-file');
      expect(prep).toBeDefined();
      expect(prep!.body).toEqual({ id: 'zhishi-env-pwn-1', envPath: '/work/out.bin' });
      expect(captured.some((c) => c.url === '/refs/dl000001')).toBe(true);
      expect(readFileSync(dest).equals(GET_FILE_BYTES)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('put-file 缺 <env-path> → 用法报错且不发请求', async () => {
    captured = [];
    const r = await runCli(['env', 'put-file', 'zhishi-env-pwn-1', 'poc.txt']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('env-path');
    expect(captured.some((c) => c.url.startsWith('/api/files/upload'))).toBe(false);
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

describe('1.6.3 refs 大值外溢消费端（debt #2）', () => {
  it('refs get <id> → GET 根路径 /refs/<id> 并原样打印全文', async () => {
    captured = [];
    const r = await runCli(['refs', 'get', 'aaaa1111']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('BIG-OUTPUT');
    expect(captured.some((c) => c.url === '/refs/aaaa1111')).toBe(true);
  }, 30_000);

  it('refs get 已 GC 的 ref（404）→ 退出 1 + 过期降级提示', async () => {
    const r = await runCli(['refs', 'get', 'dead0000']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('不存在或已过期');
  }, 30_000);

  it('refs get 非法 id → 退出 2 且不发请求', async () => {
    captured = [];
    const r = await runCli(['refs', 'get', 'ZZ!!']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('非法 ref id');
    expect(captured.some((c) => c.url.startsWith('/refs/'))).toBe(false);
  }, 30_000);

  it("printResult 深扫：响应嵌 {kind:'ref'} 占位 → stderr 打取回指引", async () => {
    const r = await runCli(['config', 'get', 'k']);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('zhishi refs get ab12cd34');
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

describe('1.7.7：auto-run CLI 命令组（三输入 + 可选空转话术）', () => {
  it('start 全旗标 → /api/admin/auto-run/start；criteria 数组、budget 对象、无 policy', async () => {
    captured = [];
    const r = await runCli([
      'auto-run', 'start', 'demo',
      '--goal', '拿到 flag',
      '--env-key', 'pwn-vm',
      '--criteria', '输出 flag',
      '--criteria', 'PoC 稳定复现 3 次',
      '--budget-kind', 'turns', '--budget-limit', '30',
    ]);
    expect(r.code).toBe(0);
    const req = captured.find((c) => c.url === '/api/admin/auto-run/start');
    expect(req).toBeDefined();
    expect(req!.body.name).toBe('demo');
    expect(req!.body.goal).toBe('拿到 flag');
    expect(req!.body.envKey).toBe('pwn-vm');
    expect(req!.body.criteria).toEqual(['输出 flag', 'PoC 稳定复现 3 次']);
    expect(req!.body.budget).toEqual({ kind: 'turns', limit: 30 });
    expect(req!.body.policy).toBeUndefined();
    expect(req!.body.stallPrompt).toBeUndefined();
  }, 30_000);

  it('--stall-prompt 透传（off = 关闭常量）', async () => {
    captured = [];
    const r = await runCli([
      'auto-run', 'start', 'demo',
      '--goal', 'g', '--env-key', 'pwn-vm', '--criteria', 'c',
      '--budget-kind', 'turns', '--budget-limit', '5',
      '--stall-prompt', '换个思路再试',
    ]);
    expect(r.code).toBe(0);
    const req = captured.find((c) => c.url === '/api/admin/auto-run/start');
    expect(req).toBeDefined();
    expect(req!.body.stallPrompt).toBe('换个思路再试');

    captured = [];
    const r2 = await runCli([
      'auto-run', 'start', 'demo',
      '--goal', 'g', '--env-key', 'pwn-vm', '--criteria', 'c',
      '--budget-kind', 'turns', '--budget-limit', '5',
      '--stall-prompt', 'off',
    ]);
    expect(r2.code).toBe(0);
    const req2 = captured.find((c) => c.url === '/api/admin/auto-run/start');
    expect(req2).toBeDefined();
    expect(req2!.body.stallPrompt).toBe('off');
  }, 30_000);

  it('list 路由与载荷（workspace 透传）', async () => {
    captured = [];
    const r = await runCli(['auto-run', 'list', '--workspace', '/ws']);
    expect(r.code).toBe(0);
    const req = captured.find((c) => c.url === '/api/admin/auto-run/list');
    expect(req).toBeDefined();
    expect(req!.body).toEqual({ workspace: '/ws' });
  }, 30_000);
});

describe('1.8.7 P0.5：远端模式（--server/--token）', () => {
  // 远端分支整体短路端口链与 ensureCliSidecar——下列用例全部不传有效
  // ZHISHI_PORT，若 CLI 误走本机链必然 ECONNREFUSED/自立 sidecar（进程表可证）。
  it('--server 旗标：所有请求发往该 URL（admin base 派生），不碰本机端口链', async () => {
    captured = [];
    const r = await runCli(['status', '--server', `http://127.0.0.1:${port}`], { ZHISHI_PORT: '1' });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('[zhishi] 远端模式：');
    expect(captured.some((c) => c.url === '/health')).toBe(true);
    expect(captured.some((c) => c.url === '/api/admin/status')).toBe(true);
  }, 30_000);

  it('base 派生：缺 scheme 补 http://、尾部斜杠剥离', async () => {
    captured = [];
    const r = await runCli(['status', '--server', `127.0.0.1:${port}/`]);
    expect(r.code).toBe(0);
    expect(captured.some((c) => c.url === '/api/admin/status')).toBe(true);
  }, 30_000);

  it('ZHISHI_SERVER 环境变量同样进入远端模式', async () => {
    captured = [];
    const r = await runCli(['status'], { ZHISHI_SERVER: `http://127.0.0.1:${port}`, ZHISHI_PORT: '1' });
    expect(r.code).toBe(0);
    expect(captured.some((c) => c.url === '/api/admin/status')).toBe(true);
  }, 30_000);

  it('优先级：--server 覆盖 ZHISHI_SERVER（env 指向死端口仍成功）', async () => {
    captured = [];
    const r = await runCli(
      ['status', '--server', `http://127.0.0.1:${port}`],
      { ZHISHI_SERVER: 'http://127.0.0.1:1' },
    );
    expect(r.code).toBe(0);
    expect(captured.some((c) => c.url === '/api/admin/status')).toBe(true);
  }, 30_000);

  it('远端不可达 → 退出 3，报错含 URL 且明说不拉起本机 sidecar', async () => {
    captured = [];
    const r = await runCli(['status', '--server', 'http://127.0.0.1:1']);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('http://127.0.0.1:1');
    expect(r.stderr).toContain('remote mode: no local sidecar will be started');
    expect(captured.some((c) => c.url === '/api/admin/status')).toBe(false);
  }, 30_000);

  it('--token：admin 与 /refs 非 admin 路由均挂 Bearer 头；token 值不打印', async () => {
    captured = [];
    const r = await runCli(['status', '--server', `http://127.0.0.1:${port}`, '--token', 'test-token-xyz']);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('Bearer token 已启用');
    expect(r.stderr).not.toContain('test-token-xyz');
    const statusReq = captured.find((c) => c.url === '/api/admin/status');
    expect(statusReq?.headers.authorization).toBe('Bearer test-token-xyz');

    captured = [];
    const r2 = await runCli(['refs', 'get', 'aaaa1111', '--server', `http://127.0.0.1:${port}`, '--token', 'test-token-xyz']);
    expect(r2.code).toBe(0);
    expect(r2.stdout).toContain('BIG-OUTPUT');
    const refReq = captured.find((c) => c.url === '/refs/aaaa1111');
    expect(refReq?.headers.authorization).toBe('Bearer test-token-xyz');
  }, 30_000);

  it('ZHISHI_TOKEN 环境变量同样挂头', async () => {
    captured = [];
    const r = await runCli(['status'], {
      ZHISHI_SERVER: `http://127.0.0.1:${port}`,
      ZHISHI_TOKEN: 'env-token',
    });
    expect(r.code).toBe(0);
    const statusReq = captured.find((c) => c.url === '/api/admin/status');
    expect(statusReq?.headers.authorization).toBe('Bearer env-token');
  }, 30_000);

  it('本机模式回归：不设 --server 时不带 Authorization 头（行为一字节不变）', async () => {
    captured = [];
    const r = await runCli(['status']);
    expect(r.code).toBe(0);
    const statusReq = captured.find((c) => c.url === '/api/admin/status');
    expect(statusReq?.headers.authorization).toBeUndefined();
    expect(r.stderr).not.toContain('远端模式');
  }, 30_000);
});

describe('1.8.7 P1：auth 子命令（团队大脑 token 管理）', () => {
  it('auth add --name A --role reviewer → /api/admin/auth/add 载荷正确，stdout 打 secret 一次', async () => {
    captured = [];
    const r = await runCli(['auth', 'add', '--name', 'A', '--role', 'reviewer']);
    expect(r.code).toBe(0);
    const req = captured.find((c) => c.url === '/api/admin/auth/add');
    expect(req).toBeDefined();
    expect(req!.body).toEqual({ name: 'A', role: 'reviewer' });
    expect(r.stdout).toContain('secret: zst_mocksecret');
    expect(r.stdout).toContain('仅此一次');
  }, 30_000);

  it('auth add 非法 role → CLI 侧拒绝，不发请求', async () => {
    captured = [];
    const r = await runCli(['auth', 'add', '--name', 'A', '--role', 'admin']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('--role');
    expect(captured.some((c) => c.url === '/api/admin/auth/add')).toBe(false);
  }, 30_000);

  it('auth revoke <id> → /api/admin/auth/revoke { id }', async () => {
    captured = [];
    const r = await runCli(['auth', 'revoke', 'tok_test01']);
    expect(r.code).toBe(0);
    const req = captured.find((c) => c.url === '/api/admin/auth/revoke');
    expect(req).toBeDefined();
    expect(req!.body).toEqual({ id: 'tok_test01' });
  }, 30_000);

  it('auth list → /api/admin/auth/list，打印 enabled 状态与 token 行（无哈希）', async () => {
    captured = [];
    const r = await runCli(['auth', 'list']);
    expect(r.code).toBe(0);
    expect(captured.some((c) => c.url === '/api/admin/auth/list')).toBe(true);
    expect(r.stdout).toContain('已启用');
    expect(r.stdout).toContain('tok_test01');
    expect(r.stdout).toContain('[reviewer]');
  }, 30_000);

  it('auth enable / disable → 对应路由空载荷', async () => {
    captured = [];
    expect((await runCli(['auth', 'enable'])).code).toBe(0);
    expect(captured.some((c) => c.url === '/api/admin/auth/enable')).toBe(true);
    captured = [];
    expect((await runCli(['auth', 'disable'])).code).toBe(0);
    expect(captured.some((c) => c.url === '/api/admin/auth/disable')).toBe(true);
  }, 30_000);
});
