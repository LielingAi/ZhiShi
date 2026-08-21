// ============= MCP API =============
// Extracted from index.ts (1.1.7 ③ god-file strangler split — pure move).
// The /api/mcp/* route branches (incl. MCP OAuth) lived inside main()'s
// request handler; they are now standalone handlers. The only index-module-
// scope values they captured were `jsonResponse`/`pathname` (passed in as
// params) plus `getCommandDownloadInfo` (moved here — nothing outside
// /api/mcp/enable used it).

import { join } from 'path';

import { setMcpServers, getMcpServers } from '../agent-session';

import { getBuiltinMcpInstance } from '../tools/builtin-mcp-registry';

import type { McpServerDefinition } from '../../shared/config-types';

import type { JsonResponseFn } from '../cron/routes';

/**

 * Runtime download URLs for common MCP commands

 */

const RUNTIME_DOWNLOAD_URLS: Record<string, { name: string; url: string }> = {

  'node': { name: 'Node.js', url: 'https://nodejs.org/' },

  'npx': { name: 'Node.js', url: 'https://nodejs.org/' },

  'npm': { name: 'Node.js', url: 'https://nodejs.org/' },

  'python': { name: 'Python', url: 'https://www.python.org/downloads/' },

  'python3': { name: 'Python', url: 'https://www.python.org/downloads/' },

  'deno': { name: 'Deno', url: 'https://deno.land/' },

  'uv': { name: 'uv (Python 包管理器)', url: 'https://docs.astral.sh/uv/' },

  'uvx': { name: 'uv (Python 包管理器)', url: 'https://docs.astral.sh/uv/' },

};

/**

 * Get download info for a command

 */

function getCommandDownloadInfo(command: string): { runtimeName?: string; downloadUrl?: string } {

  const info = RUNTIME_DOWNLOAD_URLS[command];

  if (info) {

    return { runtimeName: info.name, downloadUrl: info.url };

  }

  return {};

}


export async function handleMcpSet(request: Request, jsonResponse: JsonResponseFn): Promise<Response> {

        try {

          const payload = await request.json() as { servers?: McpServerDefinition[] };

          const servers = payload?.servers ?? [];

          setMcpServers(servers);

          return jsonResponse({ success: true, servers: servers.map(s => s.id) });

        } catch (error) {

          console.error('[api/mcp/set] Error:', error);

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Failed to set MCP servers' },

            500

          );

        }

}

export async function handleMcpGet(jsonResponse: JsonResponseFn): Promise<Response> {

        try {

          const servers = getMcpServers();

          return jsonResponse({ success: true, servers });

        } catch (error) {

          console.error('[api/mcp] Error:', error);

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Failed to get MCP servers' },

            500

          );

        }

}

export async function handleMcpEnable(request: Request, jsonResponse: JsonResponseFn): Promise<Response> {

        try {

          const payload = await request.json() as {

            server: McpServerDefinition;

          };



          const server = payload.server;

          if (!server) {

            return jsonResponse({ success: false, error: 'Missing server' }, 400);

          }



          // Resolve sentinel commands to display names for logs, so

          // __bundled_cuse__ / __builtin__ never leak into unified logs or

          // user-facing error surfaces.

          const displayCommand = server.command === '__builtin__'

            ? '(builtin)'

            : server.command === '__bundled_cuse__' ? 'cuse'

            : server.command === '__bundled_terminator__' ? 'terminator' : server.command;

          console.log(`[api/mcp/enable] Enabling MCP: ${server.id}, type: ${server.type}, command: ${displayCommand}`);



          // Built-in MCP (in-process) — delegate validation to registry.

          // getBuiltinMcpInstance() force-loads the tool module (SDK+zod) on

          // first hit; subsequent enables for the same id hit the cached entry.

          if (server.command === '__builtin__') {

            const entryPromise = getBuiltinMcpInstance(server.id);

            if (entryPromise) {

              const entry = await entryPromise;

              if (entry.validate) {

                const error = await entry.validate(server.env || {});

                if (error) {

                  return jsonResponse({ success: false, error });

                }

              }

            }

            console.log(`[api/mcp/enable] Built-in MCP: ${server.id} — enabled`);

            return jsonResponse({ success: true });

          }



          // Bundled cuse (computer-use) binary — resolve the sentinel to

          // the real path via runtime helper. This is the primary enable

          // path hit by the Settings UI toggle, so it MUST short-circuit

          // the generic `which` preflight below (which would fail with a

          // sentinel-leaking "命令 __bundled_cuse__ 未找到" error).

          if (server.command === '__bundled_cuse__') {

            const { getBundledCusePath } = await import('../utils/runtime');

            const cusePath = getBundledCusePath();

            if (!cusePath) {

              return jsonResponse({

                success: false,

                error: {

                  type: 'command_not_found',

                  command: 'cuse',

                  message: `Cuse 二进制未安装 (platform=${process.platform})。仅支持 macOS 与 Windows。`,

                },

              });

            }

            console.log(`[api/mcp/enable] Bundled cuse: ${server.id} — resolved to ${cusePath}`);

            return jsonResponse({ success: true });

          }



          // Bundled Terminator MCP agent (UIA desktop automation, PRD 0.2.36) —

          // same short-circuit as cuse: resolve the sentinel before the generic

          // `which` preflight.

          if (server.command === '__bundled_terminator__') {

            const { getBundledTerminatorPath } = await import('../utils/runtime');

            const terminatorPath = getBundledTerminatorPath();

            if (!terminatorPath) {

              return jsonResponse({

                success: false,

                error: {

                  type: 'command_not_found',

                  command: 'terminator',

                  message: `Terminator 二进制未安装 (platform=${process.platform})。仅支持 Windows。`,

                },

              });

            }

            console.log(`[api/mcp/enable] Bundled terminator: ${server.id} — resolved to ${terminatorPath}`);

            return jsonResponse({ success: true });

          }



          // SSE/HTTP types: validate remote URL is reachable and protocol matches

          if (server.type === 'sse' || server.type === 'http') {

            if (!server.url) {

              return jsonResponse({

                success: false,

                error: { type: 'connection_failed', message: '缺少服务器 URL' }

              });

            }



            try {

              const controller = new AbortController();

              const timeout = setTimeout(() => controller.abort(), 15000);



              const headers: Record<string, string> = {

                // Streamable HTTP 规范要求同时声明两种格式；SSE 只需 event-stream

                'Accept': server.type === 'sse' ? 'text/event-stream' : 'application/json, text/event-stream',

                // Request uncompressed response to avoid ZlibError.

                // Some servers (e.g., behind WAF/CDN like Huawei Cloud) return

                // content-encoding: gzip with a non-compressed body, causing Bun's

                // fetch() auto-decompression to crash. Validation doesn't need compression.

                'Accept-Encoding': 'identity',

                ...(server.headers || {}),

              };



              let response: Response;



              if (server.type === 'http') {

                // Streamable HTTP: send MCP initialize JSON-RPC request

                response = await fetch(server.url, {

                  method: 'POST',

                  headers: { ...headers, 'Content-Type': 'application/json' },

                  body: JSON.stringify({

                    jsonrpc: '2.0',

                    id: 1,

                    method: 'initialize',

                    params: {

                      protocolVersion: '2025-03-26',

                      capabilities: {},

                      clientInfo: { name: 'ZhiShi', version: '0.1.29' },

                    },

                  }),

                  signal: controller.signal,

                });

              } else {

                // SSE: send GET request to check if endpoint is reachable

                response = await fetch(server.url, {

                  method: 'GET',

                  headers,

                  signal: controller.signal,

                });

              }



              clearTimeout(timeout);



              // Helper: abort the underlying connection to prevent resource leaks

              // (especially important for SSE — the response is an infinite stream).

              const cleanup = () => { try { controller.abort(); } catch { /* ignore abort errors */ } };



              // Check HTTP status

              if (response.status === 401 || response.status === 403) {

                cleanup();

                return jsonResponse({

                  success: false,

                  error: {

                    type: 'connection_failed',

                    message: `认证失败 (HTTP ${response.status})，请检查 Headers 配置`,

                  }

                });

              }



              if (response.status === 404) {

                cleanup();

                return jsonResponse({

                  success: false,

                  error: {

                    type: 'connection_failed',

                    message: `端点不存在 (HTTP 404)，请检查 URL 是否正确`,

                  }

                });

              }



              if (response.status === 405) {

                // 405 Method Not Allowed: protocol mismatch

                cleanup();

                const hint = server.type === 'sse'

                  ? '。该端点不支持 GET，可能是 Streamable HTTP 端点，请尝试切换传输协议'

                  : '。该端点不支持 POST，可能是 SSE 端点，请尝试切换传输协议';

                return jsonResponse({

                  success: false,

                  error: {

                    type: 'connection_failed',

                    message: `请求方法不被允许 (HTTP 405)${hint}`,

                  }

                });

              }



              if (!response.ok) {

                // 尝试读取 response body 以获取更具体的错误信息

                let detail = '';

                try {

                  const body = await response.json() as Record<string, unknown>;

                  const raw = String(body.message || body.msg || body.error || '');

                  detail = raw.length > 200 ? raw.slice(0, 200) + '…' : raw;

                } catch { /* body 不是 JSON，忽略 */ }

                cleanup();

                return jsonResponse({

                  success: false,

                  error: {

                    type: 'connection_failed',

                    message: `服务器返回错误 (HTTP ${response.status})${detail ? '：' + detail : ''}`,

                  }

                });

              }



              // Protocol-specific validation

              const contentType = response.headers.get('content-type') || '';



              if (server.type === 'sse') {

                // SSE validation only needs headers — abort the infinite stream immediately

                cleanup();



                // SSE endpoint should return text/event-stream

                if (!contentType.includes('text/event-stream')) {

                  // If the URL returns JSON, it's likely a Streamable HTTP endpoint

                  const hint = contentType.includes('application/json') || contentType.includes('text/html')

                    ? '。该 URL 可能是 Streamable HTTP 端点，请尝试切换传输协议为 "Streamable HTTP"'

                    : '';

                  return jsonResponse({

                    success: false,

                    error: {

                      type: 'connection_failed',

                      message: `服务器返回的内容类型不是 SSE (${contentType || 'unknown'})${hint}`,

                    }

                  });

                }

              } else {

                // Streamable HTTP: server may respond with JSON or SSE (both valid per spec)

                // (response.ok is guaranteed here — non-ok statuses returned above)

                if (contentType.includes('text/event-stream')) {

                  // SSE response to POST — valid per MCP Streamable HTTP spec.

                  // Read enough to extract the first JSON-RPC message from SSE data lines.

                  try {

                    const text = await response.text();

                    cleanup();

                    const dataLine = text.split('\n').find(l => l.startsWith('data:'));

                    if (dataLine) {

                      const body = JSON.parse(dataLine.slice(5));

                      if (!body.jsonrpc && !body.result && !body.error) {

                        return jsonResponse({

                          success: false,

                          error: {

                            type: 'connection_failed',

                            message: '服务器 SSE 响应中的数据不是有效的 JSON-RPC 格式',

                          }

                        });

                      }

                    }

                    // SSE stream with valid data or empty (server might send events later) — accept

                  } catch {

                    cleanup();

                    return jsonResponse({

                      success: false,

                      error: {

                        type: 'connection_failed',

                        message: '无法解析服务器的 SSE 响应，请检查 URL 和传输协议',

                      }

                    });

                  }

                } else {

                  // JSON response — original path

                  try {

                    const body = await response.json();

                    cleanup();

                    if (!body.jsonrpc && !body.result && !body.error) {

                      return jsonResponse({

                        success: false,

                        error: {

                          type: 'connection_failed',

                          message: '服务器响应不是有效的 JSON-RPC 格式，请检查 URL 和传输协议',

                        }

                      });

                    }

                  } catch {

                    cleanup();

                    return jsonResponse({

                      success: false,

                      error: {

                        type: 'connection_failed',

                        message: `服务器响应不是有效的 JSON 格式 (${contentType || 'unknown'})`,

                      }

                    });

                  }

                }

              }



              console.log(`[api/mcp/enable] Remote MCP validated: ${server.id} (${server.type}) → ${server.url}`);

              return jsonResponse({ success: true });



            } catch (err: unknown) {

              const error = err instanceof Error ? err : new Error(String(err));

              console.error(`[api/mcp/enable] Remote MCP validation failed: ${server.id}`, error.message);



              let message: string;

              if (error.name === 'AbortError') {

                message = '连接超时（15秒），请检查 URL 是否正确或服务器是否可达';

              } else if (error.message.includes('ENOTFOUND') || error.message.includes('getaddrinfo')) {

                message = 'DNS 解析失败，请检查 URL 域名是否正确';

              } else if (error.message.includes('ECONNREFUSED')) {

                message = '连接被拒绝，请检查服务器是否在运行';

              } else if (error.message.includes('ECONNRESET')) {

                message = '连接被重置，请检查网络或服务器状态';

              } else if (error.message.includes('certificate') || error.message.includes('SSL') || error.message.includes('TLS')) {

                message = 'SSL/TLS 证书错误，请检查服务器证书配置';

              } else if (error.message.includes('Zlib') || error.message.includes('Decompression')) {

                // WAF/CDN may return content-encoding: gzip with non-compressed body.

                // Bun's fetch auto-decompression crashes. Skip validation and let SDK handle it.

                console.warn(`[api/mcp/enable] ZlibError during validation (WAF/CDN issue), allowing MCP: ${server.id}`);

                return jsonResponse({ success: true });

              } else {

                message = `连接失败: ${error.message}`;

              }



              return jsonResponse({

                success: false,

                error: { type: 'connection_failed', message }

              });

            }

          }



          // stdio type: validate command

          if (server.type === 'stdio' && server.command) {

            const command = server.command;



            // Preset MCP (isBuiltin: true) with npx → warmup to download and cache package

            if (server.isBuiltin && command === 'npx') {

              const { getBundledNodeDir, getSystemNpxPaths, findExistingPath } = await import('../utils/runtime');

              // M4c: pinMcpPackageVersions(SDK-ism)已删除,args 恒等透传。

              const args = server.args || [];



              // Route through utils/subprocess.spawn — on Windows the bundled

              // and system npx are both `npx.cmd` shims. Calling .cmd via raw

              // `child_process.spawn` returns EINVAL on Node ≥20.12 (CVE-2024-27980),

              // and Node's own `shell: true` workaround does NOT escape inner

              // quotes / metachars in args. The wrapper handles both — see

              // utils/subprocess.ts::spawn for the cmd.exe wrapping + cross-spawn

              // escape algorithm.

              const { spawn: wrappedSpawn } = await import('../utils/subprocess');

              const { getShellEnv } = await import('../utils/shell');

              const baseEnv = getShellEnv();



              // Priority: system npx → bundled Node.js npx → hard fail.

              // v0.2.0+ removed the "bun x" emergency branch — bundled Node is always present

              // in release builds, and dev builds fall back to system node via runtime.ts.

              const systemNpx = findExistingPath(getSystemNpxPaths());

              const nodeDir = getBundledNodeDir();

              let warmupCmd: string;

              let warmupArgs: string[];



              if (systemNpx) {

                // 1. System npx available — most reliable, user-maintained

                warmupCmd = systemNpx;

                warmupArgs = ['-y', ...args, '--help'];



                // Ensure system npx's directory is in PATH (GUI-launched apps may have minimal PATH)

                const { dirname } = await import('path');

                const npxDir = dirname(systemNpx);

                const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';

                const sep = process.platform === 'win32' ? ';' : ':';

                if (!(baseEnv[pathKey] || '').includes(npxDir)) {

                  baseEnv[pathKey] = npxDir + sep + (baseEnv[pathKey] || '');

                }



                console.log(`[api/mcp/enable] Warming up with system npx: ${warmupArgs.join(' ')}`);

              } else if (nodeDir) {

                // 2. Fallback to bundled Node.js npx

                const npxPath = process.platform === 'win32'

                  ? join(nodeDir, 'npx.cmd')

                  : join(nodeDir, 'npx');

                warmupCmd = npxPath;

                warmupArgs = ['-y', ...args, '--help'];



                // Ensure bundled Node.js bin dir is in PATH for npx to find node

                const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';

                const sep = process.platform === 'win32' ? ';' : ':';

                baseEnv[pathKey] = nodeDir + sep + (baseEnv[pathKey] || '');



                console.log(`[api/mcp/enable] Warming up with bundled npx: ${warmupArgs.join(' ')}`);

              } else {

                // 3. Neither system nor bundled Node.js found — hard fail.

                return jsonResponse({

                  success: false,

                  error: {

                    type: 'runtime_error',

                    message: '运行时不可用（系统/内置 Node.js 均未找到）',

                  }

                });

              }



              const handle = wrappedSpawn([warmupCmd, ...warmupArgs], {

                env: baseEnv,

                stdin: 'ignore',

                stdout: 'pipe',

                stderr: 'pipe',

              });



              // Drain stderr — wrappedSpawn exposes it as a Web ReadableStream

              // (Bun.spawn-shape parity), not a Node Readable, so we read with

              // the Web reader API.

              let stderr = '';

              const stderrDone = (async () => {

                if (!handle.stderr) return;

                const reader = handle.stderr.getReader();

                const decoder = new TextDecoder();

                try {

                  while (true) {

                    const { done, value } = await reader.read();

                    if (done) break;

                    stderr += decoder.decode(value, { stream: true });

                  }

                } catch { /* ignore — process exit will settle handle.exited */ }

                finally {

                  reader.releaseLock();

                }

              })();



              // 2 min timeout (was the old `timeout` spawn option). If npx

              // hangs (e.g. tarball download stalled), kill the wrapper +

              // surface a warmup failure instead of leaving the request open.

              let timedOut = false;

              const timer = setTimeout(() => {

                timedOut = true;

                try { handle.kill('SIGTERM'); } catch { /* ignore */ }

              }, 120000);



              const code = await handle.exited;

              clearTimeout(timer);

              await stderrDone; // make sure all stderr bytes are captured before classifying



              // Spawn-failure path (ENOENT / bad arch / EINVAL): handle.error

              // is populated and code === -1.

              if (handle.error) {

                console.error('[api/mcp/enable] Warmup error:', handle.error);

                return jsonResponse({

                  success: false,

                  error: {

                    type: 'warmup_failed',

                    message: `预热失败: ${handle.error.message}`,

                  },

                });

              }



              if (timedOut) {

                console.warn('[api/mcp/enable] Warmup timed out after 120s');

                return jsonResponse({

                  success: false,

                  error: {

                    type: 'warmup_failed',

                    message: '预热超时（120s），请检查网络或代理设置',

                  },

                });

              }



              console.log(`[api/mcp/enable] Warmup exited with code ${code}`);

              // Code 0 or 1 is acceptable (--help may return 1 for some packages)

              // Check stderr for real errors (package not found, network issues, etc.)

              const stderrLower = stderr.toLowerCase();

              const networkKeywords = [

                'enotfound',     // DNS resolution failed

                'etimedout',     // Connection timeout

                'econnrefused',  // Connection refused

                'econnreset',    // Connection reset

                'proxy error',   // Proxy failures

                'proxy authentication', // Proxy auth required

                'bad gateway',   // Proxy 502

                'socket hang up',// Connection dropped

              ];

              const packageKeywords = [

                '404',                // HTTP 404 not found

                'package not found',  // npm/npx package resolution

                'module not found',   // Module resolution failure

                'err!',               // npm error indicator

              ];

              const isNetworkError = networkKeywords.some(kw => stderrLower.includes(kw));

              const isPackageError = packageKeywords.some(kw => stderrLower.includes(kw));



              if (isNetworkError) {

                return jsonResponse({

                  success: false,

                  error: {

                    type: 'warmup_failed',

                    message: '网络连接失败，请检查网络或代理设置',

                  },

                });

              }

              if (isPackageError) {

                return jsonResponse({

                  success: false,

                  error: {

                    type: 'package_not_found',

                    message: '包不存在或无法下载，请检查包名',

                  },

                });

              }

              if (code !== 0 && code !== 1) {

                return jsonResponse({

                  success: false,

                  error: {

                    type: 'warmup_failed',

                    message: `预热异常退出 (code ${code})`,

                  },

                });

              }

              return jsonResponse({ success: true });

            }



            // Custom MCP or non-npx command → check if command exists in user's shell PATH

            const { spawn } = await import('child_process');

            const { getShellEnv } = await import('../utils/shell');

            const checkCmd = process.platform === 'win32' ? 'where' : 'which';



            return new Promise<Response>((resolve) => {

              const proc = spawn(checkCmd, [command], { stdio: 'ignore', env: getShellEnv() });



              proc.on('error', () => {

                resolve(jsonResponse({

                  success: false,

                  error: {

                    type: 'command_not_found',

                    command,

                    message: `命令 "${command}" 未找到`,

                    ...getCommandDownloadInfo(command),

                  }

                }));

              });



              proc.on('close', (code) => {

                if (code === 0) {

                  resolve(jsonResponse({ success: true }));

                } else {

                  resolve(jsonResponse({

                    success: false,

                    error: {

                      type: 'command_not_found',

                      command,

                      message: `命令 "${command}" 未找到`,

                      ...getCommandDownloadInfo(command),

                    }

                  }));

                }

              });

            });

          }



          // Default: allow

          return jsonResponse({ success: true });

        } catch (error) {

          console.error('[api/mcp/enable] Error:', error);

          return jsonResponse({

            success: false,

            error: {

              type: 'unknown',

              message: error instanceof Error ? error.message : '启用失败',

            }

          }, 500);

        }

}

export async function handleMcpOauthDiscover(request: Request, jsonResponse: JsonResponseFn): Promise<Response> {

        try {

          const payload = await request.json() as { serverId: string; mcpUrl: string; forceRefresh?: boolean };

          if (!payload.serverId || !payload.mcpUrl) {

            return jsonResponse({ success: false, error: 'Missing serverId or mcpUrl' }, 400);

          }

          const { probeOAuthRequirement } = await import('../mcp-oauth');

          const result = await probeOAuthRequirement(payload.serverId, payload.mcpUrl, payload.forceRefresh);

          return jsonResponse({ success: true, ...result });

        } catch (error) {

          console.error('[api/mcp/oauth/discover] Error:', error);

          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Discovery failed' }, 500);

        }

}

export async function handleMcpOauthStart(request: Request, jsonResponse: JsonResponseFn): Promise<Response> {

        try {

          const payload = await request.json() as {

            serverId: string;

            serverUrl: string;

            // Manual mode fields (all optional — omit for auto mode)

            clientId?: string;

            clientSecret?: string;

            scopes?: string[];

            callbackPort?: number;

            authorizationUrl?: string;

            tokenUrl?: string;

          };



          if (!payload.serverId || !payload.serverUrl) {

            return jsonResponse({ success: false, error: 'Missing serverId or serverUrl' }, 400);

          }



          const { authorizeServer } = await import('../mcp-oauth');

          const manualConfig = payload.clientId ? {

            clientId: payload.clientId,

            clientSecret: payload.clientSecret,

            scopes: payload.scopes,

            callbackPort: payload.callbackPort,

            authorizationUrl: payload.authorizationUrl,

            tokenUrl: payload.tokenUrl,

          } : undefined;



          const { authUrl, waitForCompletion } = await authorizeServer(

            payload.serverId,

            payload.serverUrl,

            manualConfig,

          );



          // Don't await completion — return the auth URL immediately

          waitForCompletion.then((success) => {

            if (success) {

              console.log(`[api/mcp/oauth] Authorization completed for ${payload.serverId}`);

            } else {

              console.warn(`[api/mcp/oauth] Authorization failed or cancelled for ${payload.serverId}`);

            }

          });



          return jsonResponse({ success: true, authUrl });

        } catch (error) {

          console.error('[api/mcp/oauth/start] Error:', error);

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Failed to start OAuth flow' },

            500

          );

        }

}

export async function handleMcpOauthStatus(pathname: string, jsonResponse: JsonResponseFn): Promise<Response> {

        try {

          const serverId = decodeURIComponent(pathname.slice('/api/mcp/oauth/status/'.length));

          const { getOAuthStatus } = await import('../mcp-oauth');

          const result = getOAuthStatus(serverId);

          return jsonResponse({

            success: true,

            status: result.status,

            hasToken: result.status === 'connected' || result.status === 'expired',

            expiresAt: result.expiresAt,

            scope: result.scope,

          });

        } catch (error) {

          console.error('[api/mcp/oauth/status] Error:', error);

          return jsonResponse({ success: false, error: String(error) }, 500);

        }


}

export async function handleMcpOauthRefresh(request: Request, jsonResponse: JsonResponseFn): Promise<Response> {

        try {

          const payload = await request.json() as { serverId: string };

          const { manualRefreshToken } = await import('../mcp-oauth');

          const refreshed = await manualRefreshToken(payload.serverId);

          return jsonResponse({ success: refreshed, refreshed });

        } catch (error) {

          console.error('[api/mcp/oauth/refresh] Error:', error);

          return jsonResponse({ success: false, error: String(error) }, 500);

        }


}

export async function handleMcpOauthToken(request: Request, jsonResponse: JsonResponseFn): Promise<Response> {

        try {

          const payload = await request.json() as { serverId: string };

          const { revokeAuthorization } = await import('../mcp-oauth');

          await revokeAuthorization(payload.serverId);

          return jsonResponse({ success: true });

        } catch (error) {

          console.error('[api/mcp/oauth/token] Error:', error);

          return jsonResponse({ success: false, error: String(error) }, 500);

        }

}
