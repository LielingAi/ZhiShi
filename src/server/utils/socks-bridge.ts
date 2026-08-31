/**
 * HTTP-to-SOCKS5 Bridge
 *
 * Creates a local HTTP CONNECT proxy that tunnels traffic through a SOCKS5 proxy.
 * This bridges the gap between Bun/Node.js (which only understand HTTP proxies via
 * HTTP_PROXY/HTTPS_PROXY env vars) and SOCKS5 proxies.
 *
 * Flow:
 *   SDK subprocess → HTTP_PROXY=http://127.0.0.1:<bridge-port>
 *     → Bridge receives HTTP CONNECT request
 *     → Bridge creates SOCKS5 connection to target
 *     → Data flows bidirectionally through the tunnel
 *
 * Used by: agent-session.ts initSocksBridgeFromEnv()（1.5.4 起 setProxyConfig 已删——
 *     无运行时调用方,仅启动期环境继承）
 */

import http from 'http';
import net from 'net';
import { SocksClient, type SocksProxy } from 'socks';

let bridgeServer: http.Server | null = null;
let bridgePort = 0;
/** The original SOCKS5 proxy URL (for display/logging) */
let originalSocksUrl = '';

/**
 * Start the HTTP-to-SOCKS5 bridge on a random local port.
 * If a bridge is already running, stops it first.
 *
 * @returns The local port the bridge is listening on
 */
export async function startSocksBridge(socksHost: string, socksPort: number): Promise<number> {
  // Stop existing bridge if running
  await stopSocksBridge();

  originalSocksUrl = `socks5://${socksHost}:${socksPort}`;

  const proxy: SocksProxy = {
    host: socksHost,
    port: socksPort,
    type: 5,
  };

  bridgeServer = http.createServer((_req, res) => {
    // Non-CONNECT requests are not supported — all real proxy traffic uses CONNECT
    // (HTTPS to Anthropic API, MCP servers, etc.). Returning 405 is correct.
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('SOCKS5 bridge only supports CONNECT tunneling (HTTPS)');
  });

  // Handle CONNECT method for HTTPS tunneling (the primary use case)
  bridgeServer.on('connect', async (req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) => {
    const [host, portStr] = (req.url ?? '').split(':');
    const port = parseInt(portStr) || 443;

    try {
      const { socket: socksSocket } = await SocksClient.createConnection({
        proxy,
        command: 'connect',
        destination: { host, port },
      });

      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

      if (head.length > 0) {
        socksSocket.write(head);
      }

      // Bidirectional pipe
      socksSocket.pipe(clientSocket);
      clientSocket.pipe(socksSocket);

      // Clean up on close/error
      clientSocket.on('end', () => socksSocket.end());
      socksSocket.on('end', () => clientSocket.end());
      clientSocket.on('error', () => socksSocket.destroy());
      socksSocket.on('error', () => clientSocket.destroy());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[socks-bridge] CONNECT to ${host}:${port} failed: ${msg}`);
      try {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        clientSocket.end();
      } catch { /* socket already closed */ }
    }
  });

  // Don't let bridge errors crash the sidecar
  bridgeServer.on('error', (err) => {
    console.error('[socks-bridge] Server error:', err.message);
  });

  return new Promise<number>((resolve, reject) => {
    bridgeServer!.listen(0, '127.0.0.1', () => {
      const addr = bridgeServer!.address();
      if (addr && typeof addr === 'object') {
        bridgePort = addr.port;
        console.log(`[socks-bridge] HTTP-to-SOCKS5 bridge started on 127.0.0.1:${bridgePort} → ${originalSocksUrl}`);
        resolve(bridgePort);
      } else {
        reject(new Error('[socks-bridge] Failed to get bridge address'));
      }
    });
    bridgeServer!.on('error', (e) => {
      reject(new Error(`[socks-bridge] Failed to start: ${e.message}`));
    });
  });
}

/**
 * Stop the SOCKS5 bridge if running.
 */
export async function stopSocksBridge(): Promise<void> {
  if (!bridgeServer) return;
  return new Promise<void>((resolve) => {
    bridgeServer!.close(() => {
      if (bridgePort > 0) {
        console.log(`[socks-bridge] Bridge stopped (was on port ${bridgePort})`);
      }
      bridgeServer = null;
      bridgePort = 0;
      originalSocksUrl = '';
      resolve();
    });
    // Force close immediately — SOCKS tunnel connections may be long-lived
    try { bridgeServer?.closeAllConnections?.(); } catch { /* noop */ }
  });
}

/**
 * Check if the SOCKS5 bridge is running.
 */
export function isSocksBridgeRunning(): boolean {
  return bridgeServer !== null && bridgePort > 0;
}

