'use strict';

/**
 * ZhiShi remote relay —— 团队大脑远端模式的本地回环 TCP 转发器。
 *
 * 为什么存在（1.8.7 团队大脑 → 2.0.3 中继）：
 *   成员 GUI 的页面是安全上下文（Tauri webview 的 http://tauri.localhost），
 *   浏览器混合内容规则会掐死页面向 http://<局域网IP> 发起的**一切**请求
 *   （fetch / SSE / WebSocket 全部不能豁免），auth 开启后服务端 CORS
 *   allowlist 也只放行 Tauri origin 与回环地址（src/server/auth/cors.ts）。
 *   绕行这两道闸的唯一办法是让 GUI 请求的目标保持回环——这正是
 *   `ssh -L 7411:127.0.0.1:7411 user@brain` 手工隧道干的事。本进程把这条
 *   隧道变成应用内建能力：成员零配置、不依赖成员机有 sshd。
 *
 * 语义（与 ssh -L 完全同构的哑管道）：
 *   - 监听 127.0.0.1 的某个 TCP 端口（--port 指定，缺省由 OS 分配），
 *     每个接入连接原样转发到 --target-host:--target-port，双向字节流
 *     不解析、不改写（HTTP / SSE / WebSocket upgrade / 大文件全透明）。
 *   - 半关闭传播：任一端 FIN → 对端 end()（pipe end:true 默认语义），
 *     WebSocket/SSE 的正常关闭由此工作；任一端错误/关闭 → 对端 destroy。
 *   - 目标不可达 → 该连接立即被拒绝（连接层 RST），调用方拿到
 *     "connection refused" 语义——探活/重试交给上层（GUI 连接失败态）。
 *
 * 契约（Rust 侧 src-tauri/src/remote_relay.rs 消费）：
 *   - stdout 第一行且仅此行：`ZHISHI_RELAY_READY <port>`，之后 stdout 不再
 *     写入任何内容（防止管道缓冲被无关输出撑满）。
 *   - stderr 可自由写诊断（Rust 逐行转统一日志）。
 *   - 绝不打印 payload / URL / token——隧道里的字节是端到端加密的鉴权
 *     材料（Bearer 头、?token=），本进程不可见也不可见。
 *
 * 安全边界：只绑回环（默认 127.0.0.1）。任何能访问该端口的本机进程都能
 * 借道访问团队大脑——与 ssh -L 的信任模型一致，大脑侧的 token 鉴权兜底。
 *
 * 生命周期：由 Rust（remote_relay 模块）spawn / kill。Windows 上
 * CREATE_NO_WINDOW 子进程收不到控制台信号，正常路径走 kill() 终止。
 */

const net = require('node:net');

const READY_PREFIX = 'ZHISHI_RELAY_READY ';

function usage() {
  return (
    '用法: node relay.cjs --target-host <host> --target-port <port> [--bind 127.0.0.1] [--port <listenPort>]\n' +
    '  监听回环地址，把每个 TCP 连接原样转发到目标（等价 ssh -L 的哑管道）。\n' +
    '  stdout 首行输出 ZHISHI_RELAY_READY <port>。'
  );
}

function parseArgs(argv) {
  const args = { bind: '127.0.0.1', port: 0 };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--target-host') {
      if (!value || value.startsWith('--')) return { error: '--target-host 缺参数' };
      args.targetHost = value;
      i++;
    } else if (key === '--target-port') {
      if (!value || value.startsWith('--')) return { error: '--target-port 缺参数' };
      args.targetPort = Number(value);
      i++;
    } else if (key === '--bind') {
      if (!value || value.startsWith('--')) return { error: '--bind 缺参数' };
      args.bind = value;
      i++;
    } else if (key === '--port') {
      if (!value || value.startsWith('--')) return { error: '--port 缺参数' };
      args.port = Number(value);
      i++;
    } else {
      return { error: `未知参数：${key}` };
    }
  }
  if (typeof args.targetHost !== 'string' || !args.targetHost.trim()) {
    return { error: '--target-host 必填（仅主机名/IP，不含 scheme）' };
  }
  // host 里不允许出现 scheme/路径分隔——Rust 侧已按 URL 解析出裸主机，
  // 这里再挡一层防误用（scheme 会让 net.connect 静默走 DNS 查询失败路径）。
  if (/[/\\]/.test(args.targetHost)) {
    return { error: '--target-host 必须是裸主机名/IP（不含 scheme 与路径）' };
  }
  args.targetHost = args.targetHost.trim();
  if (!Number.isInteger(args.targetPort) || args.targetPort < 1 || args.targetPort > 65535) {
    return { error: `--target-port 必须是 1-65535 的整数（收到：${String(argv.join(' '))}）` };
  }
  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) {
    return { error: '--port 必须是 0-65535 的整数（0 = OS 分配）' };
  }
  return { args };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    process.stderr.write(`[relay] 参数错误：${parsed.error}\n${usage()}\n`);
    process.exit(2);
  }
  const { targetHost, targetPort, bind, port } = parsed.args;

  /** @type {Set<import('node:net').Socket>} */
  const connections = new Set();

  // allowHalfOpen：accepted socket 收到对端 FIN 时**不**自动回 FIN——
  // 半关闭必须经 pipe 传播到对端（否则 relay 自己抢答，隧道语义尽毁）。
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    connections.add(client);
    client.once('close', () => connections.delete(client));

    const upstream = net.connect({ host: targetHost, port: targetPort });

    // 连接建立前客户端数据由内核缓冲；建立后双向 pipe（end:true——
    // 任一端 FIN 传播为对端 end()，半关闭语义对 HTTP keep-alive /
    // WebSocket 关闭握手都正确）。
    upstream.once('connect', () => {
      client.pipe(upstream);
      upstream.pipe(client);
    });
    // 目标拒绝/不可达 → 立刻断开该连接（连接层 RST），上层据此拿到
    // refused 语义。客户端先走 → upstream 陪葬，防泄漏。
    upstream.once('error', () => client.destroy());
    client.once('error', () => upstream.destroy());
    // 任一端完全关闭 → 对端 destroySoon（等带内未flush的数据写完再拆）。
    // 不能裸 destroy：半关闭场景下对端可能还有回包未写出（FIN 已排队），
    // 裸 destroy 在 Windows 上会把待发数据变成 RST——实测表现为 ECONNRESET
    // 吞掉正常关闭语义（WebSocket/SSE 的干净关闭握手由此被破坏）。
    client.once('close', () => upstream.destroySoon());
    upstream.once('close', () => client.destroySoon());
  });

  server.once('error', (err) => {
    process.stderr.write(`[relay] 监听 ${bind}:${port} 失败：${err.message}\n`);
    process.exit(1);
  });

  server.listen(port, bind, () => {
    const address = server.address();
    const listenPort = typeof address === 'object' && address ? address.port : port;
    process.stderr.write(`[relay] ${bind}:${listenPort} → ${targetHost}:${targetPort}\n`);
    // 契约：stdout 只有这一行（Rust 解析后就不再读 stdout）。
    process.stdout.write(`${READY_PREFIX}${listenPort}\n`);
  });

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const s of connections) s.destroy();
    server.close(() => process.exit(0));
    // server.close 等待既有连接销毁；上面已 destroy，双保险兜底防挂死。
    setTimeout(() => process.exit(0), 1000).unref();
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
