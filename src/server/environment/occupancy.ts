/**
 * 1.8.7 P5 团队大脑——环境占用（谁在用哪个环境，自何时，哪条线）。
 *
 * 模型：每环境一条占用 { by, line?, since }（by=actor 名；line=loopSessionId
 * ——turn 占用带线，一次性 exec 占用不带）。
 *   - 写入点：turn 起跑（chat-engine startPiTurn / invokePiSession）与
 *     environment/exec（admin-api）；
 *   - 清除点：turn 收尾 / exec 完成（token 匹配才摘——过期的释放不能摘掉
 *     别人的新占用）/ environment/down 成功（环境没了，占用随之失效，
 *     forceReleaseEnv 无条件摘）。
 *
 * 存储纪律：**只在内存，不落盘**——占用是运行态事实，重启的 sidecar 从空
 * 开始是诚实的答案（落盘反而要处理「盘上说占用、实际线早死了」的腐化）。
 *
 * 语义纪律：**警告不是锁**——up/down/exec 撞上他人占用只在结果里带
 * warning 字段（连同 boundary-ask 的 objects 里附上占用信息），绝不阻断
 * （设计稿 P5「占用可见」是软语义；本地单用户模式全是同一 actor，永远不
 * 触发冲突 warning，行为与 1.8.6 一字节相同）。
 */

export interface EnvOccupancy {
  /** 占用者 actor 名（token 名 / 'local'）。 */
  by: string;
  /** 占用的 loop 线（turn 占用）；一次性 exec 占用无此字段。 */
  line?: string;
  /** 占用开始（ISO）。 */
  since: string;
}

/** 释放凭据：claim 的返回值；release 只摘持有同一 token 的占用。 */
export interface OccupancyToken {
  readonly envId: string;
  readonly tag: object;
}

interface OccupiedEntry extends EnvOccupancy {
  tag: object;
}

const occupancy = new Map<string, OccupiedEntry>();

/**
 * 登记占用（turn 用）：覆盖同环境既有占用——后到的 turn 是更新的真相
 * （同线重起跑/换人都以最新登记为准）。返回释放凭据。
 */
export function claimEnv(envId: string, occ: { by: string; line?: string }): OccupancyToken {
  const tag = {};
  const entry: OccupiedEntry = { by: occ.by, since: new Date().toISOString(), tag };
  if (occ.line) entry.line = occ.line;
  occupancy.set(envId, entry);
  return { envId, tag };
}

/**
 * 空闲才登记（一次性 exec 用）：已有占用（turn 的线占用 / 另一路 exec）
 * 不踩——返回 null 表示未登记（调用方只在自己登记成功时才 release）。
 */
export function claimEnvIfFree(envId: string, occ: { by: string; line?: string }): OccupancyToken | null {
  if (occupancy.has(envId)) return null;
  return claimEnv(envId, occ);
}

/** 释放占用：仅当当前占用持有同一 token（过期释放不摘别人的新占用）。 */
export function releaseEnv(envId: string, token: OccupancyToken): void {
  const cur = occupancy.get(envId);
  if (cur && cur.tag === token.tag) occupancy.delete(envId);
}

/** 无条件摘除（environment/down 成功——环境没了，占用随之失效）。 */
export function forceReleaseEnv(envId: string): void {
  occupancy.delete(envId);
}

/** 单环境占用查询（无 → undefined）。 */
export function envOccupancy(envId: string): EnvOccupancy | undefined {
  const cur = occupancy.get(envId);
  if (!cur) return undefined;
  const { tag: _tag, ...pub } = cur;
  return pub;
}

/** 全量快照（envId → 占用；投影/调试面用）。 */
export function occupancySnapshot(): Record<string, EnvOccupancy> {
  const out: Record<string, EnvOccupancy> = {};
  for (const [id, cur] of occupancy) {
    const { tag: _tag, ...pub } = cur;
    out[id] = pub;
  }
  return out;
}

/** ISO → HH:MM（本机时区；警告文案用，完整时间戳在 occupancy.since 里）。 */
function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 冲突警告文案（软语义——结果是 warning 字段，不阻断）：
 *   `env zhishi-pwn-x 正被 wren（线 ab12cd34）占用（自 14:02）`
 * loud（environment/down 用）追加中断后果。
 */
export function formatOccupancyWarning(envId: string, occ: EnvOccupancy, opts: { loud?: boolean } = {}): string {
  const linePart = occ.line ? `（线 ${occ.line.slice(0, 8)}）` : '';
  const base = `env ${envId} 正被 ${occ.by}${linePart}${occ.line ? '' : ' '}占用（自 ${hhmm(occ.since)}）`;
  return opts.loud ? `${base}——停止将中断其进行中的工作` : base;
}

/** 测试用：清空占用表（生产无调用方——重启即空是设计语义）。 */
export function __resetOccupancyForTests(): void {
  occupancy.clear();
}
