/**
 * intel_search — 宿主侧情报检索工具（1.1.2 情报横切）。
 *
 * 与 research_log 同类：harness 原生能力，不依赖 env、不依赖外部 MCP，
 * chat-engine 的 runPiTurn 无条件注册（宿主侧能力）。执行体读 intel.db
 * （sidecar 进程持有的本地索引）：
 * - CVE 编号 → 主表精确查询；
 * - 产品/关键字 → FTS5 模糊（零命中再 LIKE 兜底）；
 * - 未命中且配置允许在线回源（intel.onlineFallback，缺省 true）→ NVD
 *   keywordSearch 单发，5s 超时，失败静默降级为「未找到」。
 *
 * 不阻塞会话：本地查询是同步 better-sqlite3（毫秒级），网络回源封 5s；
 * 索引不可用（better-sqlite3 缺失等）不 throw——按未命中路径走在线回源，
 * 全失败则返回可读的降级文本。
 */
import { Type, type Static } from '@earendil-works/pi-ai';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';

import { resolveIntelConfig, type IntelConfig } from '../../shared/config-types';
import { getZhiShiDataDir } from '../utils/app-dirs';
import { loadConfig } from '../utils/admin-config';
import {
  getMeta,
  openIntelStore,
  searchCves,
  type IntelHit,
} from '../intel/store';
import { NVD_BASE_URL } from '../intel/sync';
import type { IntelFetchFn } from '../intel/sync';
import { parseNvdPage, type ParsedCve } from '../intel/nvd-parser';

export const INTEL_SEARCH_TOOL_NAME = 'intel_search';

/** 在线回源超时（设计定稿 5s）。 */
export const INTEL_ONLINE_TIMEOUT_MS = 5000;

const intelSearchParameters = Type.Object({
  query: Type.String({
    description: 'CVE 编号精确查询（如 CVE-2024-1234）或产品/关键字模糊查询（如 apache log4j）',
  }),
  limit: Type.Optional(Type.Number({
    description: '返回条数上限（默认 5，最大 5）',
    minimum: 1,
    maximum: 5,
  })),
});

export type IntelSearchParams = Static<typeof intelSearchParameters>;

export interface IntelSearchToolDetails {
  hitCount: number;
  /** 结果是否来自在线回源（本地索引未命中后的 NVD keywordSearch）。 */
  online: boolean;
}

export interface CreateIntelSearchToolOptions {
  /** 数据目录（缺省 getZhiShiDataDir()）。测试注入临时库目录。 */
  baseDir?: string;
  /** 在线回源 fetch（测试注入 mock；缺省 Node 全局 fetch）。 */
  fetchImpl?: IntelFetchFn;
  /** 配置读取（测试注入；缺省读 config.json 的 intel 段）。 */
  resolveConfig?: () => IntelConfig | undefined;
  /** 在线回源超时（缺省 5s；测试注入小值验证降级）。 */
  onlineTimeoutMs?: number;
}

function defaultResolveConfig(): IntelConfig | undefined {
  const cfg = loadConfig() as { intel?: IntelConfig };
  return cfg.intel;
}

/** 在线回源：NVD keywordSearch 单发（限时、限条数），失败由调用方降级。 */
export async function nvdKeywordLookup(
  query: string,
  fetchImpl: IntelFetchFn,
  limit: number,
  timeoutMs: number = INTEL_ONLINE_TIMEOUT_MS,
): Promise<ParsedCve[]> {
  const params = new URLSearchParams({
    keywordSearch: query,
    resultsPerPage: String(limit),
  });
  const signal = AbortSignal.timeout(timeoutMs);
  const resp = await fetchImpl(`${NVD_BASE_URL}?${params.toString()}`, { signal });
  if (!resp.ok) throw new Error(`NVD keywordSearch HTTP ${resp.status}`);
  const page = parseNvdPage(JSON.parse(await resp.text()));
  return page.cves;
}

/** 在线回源命中 → 工具命中形状（exploitCount<0 表示未知）。 */
function toOnlineHit(cve: ParsedCve): IntelHit {
  return { ...cve, exploitCount: -1 };
}

/** 单条结果行：设计定稿格式，≤200 字（超长截断）。 */
export function formatIntelHit(hit: IntelHit): string {
  const cvss = hit.cvssScore !== null ? hit.cvssScore.toFixed(1) : 'N/A';
  const productNames = hit.products.map((p) => `${p.vendor} ${p.product}`);
  const products = productNames.length === 0
    ? '未知'
    : productNames.slice(0, 2).join('、') + (productNames.length > 2 ? ' 等' : '');
  const exploit = hit.exploitCount < 0 ? '未知' : hit.exploitCount > 0 ? '有' : '无';
  const description = hit.description.replace(/\s+/g, ' ').trim();
  const line = `${hit.id} | CVSS ${cvss} | ${description} | 受影响: ${products} | 公开 exploit: ${exploit}`;
  return line.length > 200 ? `${line.slice(0, 197)}…` : line;
}

/** 结果文本：头（索引新鲜度）+ 命中行；空命中给明确指引。 */
export function formatIntelResult(args: {
  query: string;
  hits: IntelHit[];
  lastUpdateAt: string | null;
  indexUnavailable: boolean;
  onlineUsed: boolean;
}): string {
  const header = args.lastUpdateAt
    ? `情报索引最后更新于 ${args.lastUpdateAt.slice(0, 10)}。`
    : '情报索引尚未构建（运行 zhishi intel update 初始化）。';
  const source = args.onlineUsed ? '（结果来自在线回源，未入库）' : '';
  if (args.hits.length === 0) {
    const degraded = args.indexUnavailable ? '\n（本地索引不可用，且在线回源未命中/失败）' : '';
    return `${header}\n未找到与 "${args.query}" 匹配的 CVE 情报。${degraded}`;
  }
  return `${header} 命中 ${args.hits.length} 条${source}:\n${args.hits.map(formatIntelHit).join('\n')}`;
}

/** 构造 intel_search 工具（宿主侧能力，与 research_log 并列无条件注册）。 */
export function createIntelSearchTool(
  options: CreateIntelSearchToolOptions = {},
): AgentTool<typeof intelSearchParameters, IntelSearchToolDetails> {
  const baseDir = options.baseDir ?? getZhiShiDataDir();
  const resolveCfg = options.resolveConfig ?? defaultResolveConfig;
  const fetchImpl: IntelFetchFn = options.fetchImpl ?? ((url, init) => {
    const f = (globalThis as { fetch?: unknown }).fetch;
    if (typeof f !== 'function') {
      return Promise.reject(new Error('当前 Node 运行时不提供全局 fetch（需 Node 18+）'));
    }
    return (f as IntelFetchFn)(url, init);
  });
  return {
    name: INTEL_SEARCH_TOOL_NAME,
    label: '检索 CVE 情报（NVD + exploit-db 本地索引）',
    description:
      '检索本地情报索引（NVD CVE + exploit-db）：query 传 CVE 编号精确查询（如 CVE-2024-1234）' +
      '或产品/关键字模糊查询（如 apache log4j）。返回 CVE 摘要（CVSS / 描述 / 受影响产品 / 公开 exploit）。' +
      '使用纪律：复现或验证漏洞前先核实受影响版本与公开 PoC；情报是线索不是结论；不要每步都查——' +
      '只在真正需要外部事实时调用。',
    parameters: intelSearchParameters,
    execute: async (_toolCallId, params): Promise<AgentToolResult<IntelSearchToolDetails>> => {
      const query = (params.query ?? '').trim();
      if (!query) throw new Error('intel_search 需要 query（CVE 编号或产品/关键字）');
      const limit = Math.min(Math.max(params.limit ?? 5, 1), 5);
      const cfg = resolveIntelConfig(resolveCfg());

      let hits: IntelHit[] = [];
      let lastUpdateAt: string | null = null;
      let indexUnavailable = false;
      try {
        const db = openIntelStore(baseDir);
        lastUpdateAt = getMeta(db, 'lastUpdateAt');
        hits = searchCves(db, query, limit);
      } catch (err) {
        indexUnavailable = true;
        console.warn('[intel] 本地索引不可用，走在线回源:', err instanceof Error ? err.message : String(err));
      }

      let onlineUsed = false;
      if (hits.length === 0 && cfg.onlineFallback) {
        try {
          const online = await nvdKeywordLookup(query, fetchImpl, limit, options.onlineTimeoutMs ?? INTEL_ONLINE_TIMEOUT_MS);
          hits = online.map(toOnlineHit);
          onlineUsed = hits.length > 0;
        } catch (err) {
          // 静默降级为「未找到」——5s 超时/网络失败都不阻塞会话
          console.warn('[intel] 在线回源失败，按未找到降级:', err instanceof Error ? err.message : String(err));
        }
      }

      return {
        content: [{
          type: 'text',
          text: formatIntelResult({ query, hits, lastUpdateAt, indexUnavailable, onlineUsed }),
        }],
        details: { hitCount: hits.length, online: onlineUsed },
      };
    },
  };
}
