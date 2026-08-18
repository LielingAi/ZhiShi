/**
 * Thin MCP stdio client for terminator-mcp-agent (AppCraft replay, PRD 0.2.36
 * §6.6 + specs/tech_docs/appcraft_engine_contract.md).
 *
 * Hand-rolled minimal JSON-RPC client (~no npm MCP SDK): spawns the bundled
 * terminator binary and talks newline-delimited JSON-RPC over stdio.
 *
 * Protocol flow:
 *   → {"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}
 *   ← {"jsonrpc":"2.0","id":1,"result":{...}}
 *   → {"jsonrpc":"2.0","method":"notifications/initialized","params":{}}
 *   → {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":...,"arguments":{...}}}
 *   ← {"jsonrpc":"2.0","id":2,"result":{"content":[...],"isError":false}}
 *
 * Defensive by design: stdout is parsed line-by-line and any line that is not
 * valid JSON is skipped — the upstream binary has a known stdout-pollution
 * history (chcp 65001 banner, see contract §1). One client instance is reused
 * for a whole replay session; `close()` kills the process.
 */
import { spawn as spawnSubprocess, type SubprocessHandle } from '../utils/subprocess';

/** Default per-call timeout; replay steps drive real UI so keep it generous. */
export const TERMINATOR_DEFAULT_TIMEOUT_MS = 60_000;

export interface TerminatorClientOptions {
  /** Absolute path to terminator-mcp-agent (getBundledTerminatorPath()). */
  binaryPath: string;
  defaultTimeoutMs?: number;
  /** Extra env overrides; RUST_LOG defaults to 'error' to keep stdout/stderr quiet. */
  env?: Record<string, string>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Pull human-readable text out of an MCP tool result's content array. */
function toolErrorText(result: Record<string, unknown>): string {
  const content = result.content;
  if (!Array.isArray(content)) return JSON.stringify(result);
  const parts: string[] = [];
  for (const item of content) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const text = (item as Record<string, unknown>).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('\n') || JSON.stringify(result);
}

export class TerminatorClient {
  private readonly proc: SubprocessHandle;
  private readonly defaultTimeoutMs: number;
  private nextId = 0;
  private buffer = '';
  private readonly pending = new Map<number, PendingRequest>();
  private crashed: Error | null = null;
  private readonly readyPromise: Promise<void>;

  private constructor(options: TerminatorClientOptions) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? TERMINATOR_DEFAULT_TIMEOUT_MS;
    this.proc = spawnSubprocess([options.binaryPath], {
      stdin: 'pipe',
      stdout: 'pipe',
      // stderr drained-and-dropped: with RUST_LOG=error it stays near-empty,
      // but an unread pipe would eventually block the child on a full buffer.
      stderr: 'pipe',
      windowsHide: true,
      env: { ...process.env, ...options.env, RUST_LOG: options.env?.RUST_LOG ?? 'error' },
    });
    void this.drainStderr();
    void this.readLoop();
    this.readyPromise = this.handshake();
  }

  /** Spawn + MCP initialize handshake. Rejects if the binary is missing or the handshake times out. */
  static async start(options: TerminatorClientOptions): Promise<TerminatorClient> {
    const client = new TerminatorClient(options);
    try {
      await client.readyPromise;
    } catch (err) {
      await client.close();
      throw err;
    }
    return client;
  }

  /** Call an MCP tool. Rejects on RPC error, tool-level isError, timeout, or process crash. */
  async callTool(name: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
    await this.readyPromise;
    const result = await this.request('tools/call', { name, arguments: args }, timeoutMs ?? this.defaultTimeoutMs);
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const rec = result as Record<string, unknown>;
      if (rec.isError === true) {
        throw new Error(`terminator tool '${name}' failed: ${toolErrorText(rec)}`);
      }
    }
    return result;
  }

  /** Kill the process and reject every in-flight call. Idempotent. */
  async close(): Promise<void> {
    if (this.crashed) return;
    this.onCrash(new Error('terminator client closed'));
    this.proc.kill();
    await this.proc.exited.catch(() => -1);
  }

  // -------------------------------------------------------------------------

  private async handshake(): Promise<void> {
    await this.request(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'zhishi-appcraft-replay', version: '1.0.0' },
      },
      this.defaultTimeoutMs,
    );
    await this.notify('notifications/initialized', {});
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (this.crashed) return Promise.reject(this.crashed);
    const stdin = this.proc.stdin;
    if (!stdin) return Promise.reject(new Error('terminator stdin not writable'));
    const id = ++this.nextId;
    const payload = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`terminator '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      stdin.write(payload).catch((err: unknown) => {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    if (this.crashed) throw this.crashed;
    if (!this.proc.stdin) throw new Error('terminator stdin not writable');
    await this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  private handleLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // stdout pollution (chcp banner, log leakage) — skip non-JSON lines
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    const rec = msg as Record<string, unknown>;
    if (typeof rec.id !== 'number') return; // server notification — nothing to match
    const entry = this.pending.get(rec.id);
    if (!entry) return;
    this.pending.delete(rec.id);
    clearTimeout(entry.timer);
    if (rec.error && typeof rec.error === 'object' && !Array.isArray(rec.error)) {
      const rpcErr = rec.error as Record<string, unknown>;
      entry.reject(
        new Error(`terminator RPC error ${String(rpcErr.code ?? '')}: ${String(rpcErr.message ?? 'unknown')}`),
      );
    } else {
      entry.resolve(rec.result);
    }
  }

  private async readLoop(): Promise<void> {
    const stdout = this.proc.stdout;
    if (!stdout) {
      this.onCrash(new Error('terminator stdout not piped'));
      return;
    }
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, nl).trim();
          this.buffer = this.buffer.slice(nl + 1);
          if (line) this.handleLine(line);
        }
      }
    } catch {
      // stream error — treated as a crash via the exit wait below
    }
    const code = await this.proc.exited.catch(() => -1);
    this.onCrash(new Error(`terminator-mcp-agent exited (code ${code})`));
  }

  private async drainStderr(): Promise<void> {
    const stderr = this.proc.stderr;
    if (!stderr) return;
    const reader = stderr.getReader();
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      // best-effort drain only
    }
  }

  private onCrash(err: Error): void {
    if (this.crashed) return;
    this.crashed = err;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }
}
