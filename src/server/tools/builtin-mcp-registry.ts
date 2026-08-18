// Builtin MCP Registry — two-layer design:
//   1. META (id + lazy factories) registered eagerly at sidecar startup
//      via registerBuiltinMcpMeta(). Cheap — just function refs, no SDK/zod eval.
//   2. Server INSTANCE created on-demand via getBuiltinMcpInstance(id).
//      Loads the tool module + builds SDK server only when actually needed
//      (pre-warm or user clicks "Test" in Settings).
//
// Why split: before this refactor, every tool file was eager-imported at
// module top of agent-session.ts, triggering ~500-1000ms of SDK+zod+schema
// construction on every Sidecar cold start regardless of whether any of
// the tools were actually enabled in the user's workspace. Splitting META
// from INSTANCE lets us register cheap metadata eagerly while keeping the
// heavy work (createSdkMcpServer + zod.object schemas) behind a lazy
// dynamic-import gate.

export interface BuiltinMcpSessionContext {
  sessionId: string;
  workspace?: string;
}

/** Full entry returned by the factory after the heavy module is loaded. */
export interface BuiltinMcpEntry {
  /** SDK server object (passed to Agent SDK mcpServers) */
  server: unknown;
  /**
   * Extract config from env and initialize the server. Called during
   * buildSdkMcpServers() for user-toggleable builtins.
   * Context-injected builtins (cron-tools, etc.) don't need this hook.
   */
  configure?: (env: Record<string, string>, ctx: BuiltinMcpSessionContext) => void;
  /**
   * Validate config on enable. Return error object or null if valid.
   * Called on user "Test" / "Enable" action — the meta proxy force-loads
   * the tool module before calling through.
   */
  validate?: (env: Record<string, string>) => Promise<{ type: string; message: string } | null>;
}

/** META: the bits we can register eagerly without loading the tool module. */
export interface BuiltinMcpMeta {
  id: string;
  /** Lazy factory — loads the tool module, returns a fully-populated entry */
  load: () => Promise<BuiltinMcpEntry>;
}

const metaRegistry = new Map<string, BuiltinMcpMeta>();

/** In-flight / completed instance cache, keyed by id. Dedupes concurrent loads. */
const instanceCache = new Map<string, Promise<BuiltinMcpEntry>>();

/**
 * Register a builtin MCP's META. Called at startup from a tool's META module.
 * Cheap — no tool module is loaded here, just a factory ref is stored.
 */
export function registerBuiltinMcpMeta(meta: BuiltinMcpMeta): void {
  metaRegistry.set(meta.id, meta);
}

/**
 * Lazily load a builtin MCP's full entry (server + configure + validate).
 * First call triggers the META's `load()` factory (dynamic-imports the tool
 * module, loads SDK + zod, builds server). Subsequent calls return the
 * cached promise.
 *
 * Returns undefined if the id isn't registered.
 *
 * Failure handling: if `load()` rejects (transient import failure, SDK load
 * error, zod schema construction throw), the cache entry is evicted so the
 * next call gets a clean retry. Otherwise a single transient failure would
 * permanently wedge that MCP until Sidecar restart.
 */
export function getBuiltinMcpInstance(id: string): Promise<BuiltinMcpEntry> | undefined {
  const meta = metaRegistry.get(id);
  if (!meta) return undefined;
  let cached = instanceCache.get(id);
  if (!cached) {
    cached = meta.load().catch((err) => {
      // Evict poisoned entry — next caller retries from scratch.
      instanceCache.delete(id);
      throw err;
    });
    instanceCache.set(id, cached);
  }
  return cached;
}

/**
 * List all registered builtin MCP ids. Useful for debug logging
 * at startup (`[mcp] meta registered: [...]`) so we can see the
 * lazy registrations fired without needing to load any module.
 */
export function listBuiltinMcpIds(): string[] {
  return [...metaRegistry.keys()];
}
