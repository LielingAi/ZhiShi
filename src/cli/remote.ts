/**
 * CLI 远端模式（1.8.7 P0.5 团队协作）——`--server`/`ZHISHI_SERVER` 指向
 * 服务器上的团队大脑 sidecar，CLI 仍是零状态 HTTP 客户端，只是不再假设
 * 对端在 127.0.0.1。
 *
 * 设计纪律：
 * - 纯函数 + fetch 可注入——单测不碰真实网络（remote.unit.test.ts）；
 * - 远端模式绝不拉起本机 sidecar（zhishi.ts 主流程在远端分支整体短路
 *   端口链与 ensureCliSidecar）；远端不可达是硬错误，不回落本机——
 *   「以为连着团队大脑、实际在操作本机空 sidecar」的静默分叉比报错更糟；
 * - token 只进 Authorization 头，日志只打「已启用」，绝不打印值。
 *
 * ---------------------------------------------------------------------------
 * R5 审计（P0.5 交付物）：CLI 子命令绕过 HTTP 直读 ~/.zhishi 的路径清单
 * ---------------------------------------------------------------------------
 * 逐文件走过 src/cli（grep getZhiShiDataDir / readFileSync / homedir）：
 *
 * 1. zhishi.ts 端口发现读 `~/.zhishi/sidecar.port`（+ sidecar-ensure.ts 同款
 *    探测/回写）——仅本机模式的 sidecar 发现机制；远端分支在进入该链路前
 *    整体短路，远端模式不读。处置：模式闸，无需 API 化。
 * 2. zhishi.ts printTaskCreateResult 用 getZhiShiDataDir() 拼 docs_path
 *    展示串——任务创建本身走 task/create-direct API，数据目录仅用于显示。
 *    远端模式下本机拼出的路径是错的（tasks 在服务器盘上）；处置：远端模式
 *    改打「远端 sidecar 本机路径」标注，不展示本机数据目录。
 *    （task get 的 docs.* 路径由服务端返回，本来就是 server 侧绝对路径；
 *    远端直接读写得等 P4 文件传输，不在 P0.5 范围。）
 * 3. zhishi.ts expert import 的 readFileSync(file)——读的是用户显式给的
 *    导入文件（工作区文件），非数据目录；条目仍走 expert/add API 入库。OK。
 * 4. zhishi.ts term write --data-file / task --taskMdFile 的 readFileSync——
 *    同为「AI 写盘传路径」的工作区文件惯例，非数据目录。OK。
 * 5. expert-edit.ts 编辑器往返（mkdtemp/readFileSync 临时目录）——编辑器
 *    是人侧本地行为（设计文档 R5 明写 OK）；内容经 expert/add|update API
 *    落库，远端模式天然成立。OK。
 * 6. sidecar-ensure.ts resolveServerScript 的 existsSync——本机自立 sidecar
 *    专用，远端模式不进入。OK。
 *
 * 结论：没有任何子命令为「拿数据」直读 config/sessions/db（全部走 admin
 * API），因此本轮没有需要 `仅本机模式可用（…直接读写本地数据目录）` 拒绝的
 * 命令；唯一的本机数据目录残留是展示串（#2），已按远端标注处理。
 */

/** 远端健康探测超时（照 sidecar-ensure 的 2s 口径）。 */
const REMOTE_HEALTH_TIMEOUT_MS = 2_000;

/**
 * 归一化 --server/ZHISHI_SERVER 的值：
 * - 缺 scheme 时接受 `host:port` 写法并补 `http://`；
 * - 剥尾部斜杠（调用方直接拼 `/api/admin`、`/health`，双斜杠会让路由 404）；
 * - 非法 URL 抛错（调用方翻成 CLI 报错，exit 2）。
 */
export function normalizeServerUrl(raw: string): string {
  let s = raw.trim();
  if (!s) throw new Error('empty server URL');
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) s = `http://${s}`;
  s = s.replace(/\/+$/, '');
  // new URL 只为校验形态；解析结果不回用（保留原始 host 写法，不做 punycode
  // 等归一——打到 stderr 的 URL 应与用户输入一致）。
  new URL(s);
  return s;
}

/**
 * 解析远端 server：--server 旗标 > ZHISHI_SERVER 环境变量；都未设返回
 * undefined（本机模式，调用方走原端口链）。旗标/环境变量的值非法时抛错。
 */
export function resolveRemoteServer(flags: Record<string, unknown>): string | undefined {
  const flagRaw = typeof flags.server === 'string' && flags.server.trim() ? flags.server : undefined;
  const envRaw = process.env.ZHISHI_SERVER?.trim() || undefined;
  const chosen = flagRaw ?? envRaw;
  if (!chosen) return undefined;
  return normalizeServerUrl(chosen);
}

/** 解析鉴权 token：--token 旗标 > ZHISHI_TOKEN 环境变量；都未设返回 undefined。 */
export function resolveRemoteToken(flags: Record<string, unknown>): string | undefined {
  const flagRaw = typeof flags.token === 'string' && flags.token.trim() ? flags.token : undefined;
  const envRaw = process.env.ZHISHI_TOKEN?.trim() || undefined;
  return flagRaw ?? envRaw;
}

/** 注入用的最小 fetch 形态（探测只关心 ok）。 */
export type RemoteHealthFetch = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean }>;

export type RemoteHealthResult = { ok: true } | { ok: false; error: string };

/**
 * 远端模式的就绪判据：GET <server>/health。与 sidecar-ensure 的 /health 判据
 * 同口径（TCP 通但 handler 未装的假活不算活）。带 token 时同样挂 Bearer 头
 * ——P1 鉴权上线后 /health 可能也要过闸。
 */
export async function probeRemoteHealth(
  serverBase: string,
  token?: string,
  fetchImpl?: RemoteHealthFetch,
): Promise<RemoteHealthResult> {
  const doFetch: RemoteHealthFetch = fetchImpl ?? (globalThis.fetch as unknown as RemoteHealthFetch);
  try {
    const res = await doFetch(`${serverBase}/health`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      signal: AbortSignal.timeout(REMOTE_HEALTH_TIMEOUT_MS),
    });
    return res.ok ? { ok: true } : { ok: false, error: 'GET /health 返回非 2xx' };
  } catch (err) {
    return { ok: false, error: `GET /health 失败：${err instanceof Error ? err.message : String(err)}` };
  }
}
