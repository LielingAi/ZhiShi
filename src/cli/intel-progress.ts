/**
 * zhishi intel update 的进度轮询助手（1.1.4，纯逻辑可单测）。
 *
 * update 是分钟级长任务：CLI 发出 intel/update 请求后不再傻等——本模块
 * 并发每 intervalMs 调 intel/status，把进度刷到同一行（`⏳ 情报更新中:
 * 已入库 N 条（窗口 xxx）`）；调用方在 update 响应回来（成功或失败）后
 * 调 stop() 打断轮询并清掉进度行，再打印最终结果。
 *
 * 依赖全部注入（statusFn / sleepMs / write），单测不碰网络与真实计时器；
 * 轮询自身的错误静默吞掉（update 结果仍由调用方打印，进度展示不阻塞主流程）。
 */

/** 状态响应的 progress 段（缺字段按 0/null 兜底）。 */
export interface IntelProgressSnapshot {
  inProgress: boolean;
  currentWindowLabel: string | null;
  nvdAdded: number;
  exploitCount: number;
}

/** intel/status 轮询间隔（毫秒）。 */
export const INTEL_POLL_INTERVAL_MS = 3000;

/** 进度行文本（无前缀控制字符，换行/清屏由 write 注入方负责）。 */
export function formatIntelProgressLine(p: IntelProgressSnapshot): string {
  const label = p.currentWindowLabel ? `（窗口 ${p.currentWindowLabel}）` : '';
  return `⏳ 情报更新中: 已入库 ${p.nvdAdded} 条${label}`;
}

/**
 * 从 intel/status 响应里捞出 progress 段（形状：data.status.progress）。
 * 非对象/形状不符/inProgress≠true → null（不刷行）。
 */
export function extractIntelProgress(res: unknown): IntelProgressSnapshot | null {
  if (typeof res !== 'object' || res === null) return null;
  const data = (res as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return null;
  const status = (data as { status?: unknown }).status;
  if (typeof status !== 'object' || status === null) return null;
  const p = (status as { progress?: unknown }).progress;
  if (typeof p !== 'object' || p === null) return null;
  const q = p as Record<string, unknown>;
  if (q.inProgress !== true) return null;
  return {
    inProgress: true,
    currentWindowLabel: typeof q.currentWindowLabel === 'string' ? q.currentWindowLabel : null,
    nvdAdded: typeof q.nvdAdded === 'number' ? q.nvdAdded : 0,
    exploitCount: typeof q.exploitCount === 'number' ? q.exploitCount : 0,
  };
}

export interface IntelProgressPollOptions {
  /** intel/status 调用（返回原始响应对象；形状解析见 extractIntelProgress）。 */
  statusFn: () => Promise<unknown>;
  /** 轮询间隔（毫秒）。 */
  intervalMs: number;
  /** 退避睡眠（单测注入；缺省真实 setTimeout——宏任务，不空转饿死事件循环）。 */
  sleepMs?: (ms: number) => Promise<void>;
  /** 写屏（单测注入收集器；缺省丢弃）。 */
  write?: (line: string) => void;
}

export interface IntelProgressPoller {
  /** 打断轮询。曾写过进度行时补一个空写——调用方用 `\r` 前缀 + 清行后缀
   *  组合出「清掉当前行」的效果。幂等：重复 stop 无副作用。 */
  stop: () => void;
}

/**
 * 启动进度轮询循环。每 intervalMs 查一次 status：inProgress=true 时刷一行
 * 进度（覆盖上一次，不留历史）；stop() 后不再写屏。轮询自身错误静默跳过。
 */
export function startIntelProgressPolling(opts: IntelProgressPollOptions): IntelProgressPoller {
  let stopped = false;
  let wrote = false;
  const sleep = opts.sleepMs ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const write = opts.write ?? (() => {});
  void (async () => {
    while (!stopped) {
      await sleep(opts.intervalMs);
      if (stopped) break;
      let snapshot: IntelProgressSnapshot | null = null;
      try {
        snapshot = extractIntelProgress(await opts.statusFn());
      } catch {
        // 状态轮询失败静默（sidecar 忙/重启等）——下一轮再试，update 结果仍会打印
      }
      if (stopped || snapshot === null) continue;
      wrote = true;
      write(formatIntelProgressLine(snapshot));
    }
  })();
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (wrote) write('');
    },
  };
}
