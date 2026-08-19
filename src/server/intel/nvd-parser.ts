/**
 * NVD API 2.0 响应解析层（1.1.2 情报横切）。
 *
 * 单一职责：把 /rest/json/cves/2.0 的 JSON 响应转成结构化记录。不碰网络、
 * 不碰存储——fetch 与落库分别在 sync.ts / store.ts，解析逻辑集中在这一个
 * 文件里，固定样本即可单测。
 *
 * 字段级摘要决策：description 存完整（供 FTS 检索），references / weaknesses
 * 等重字段直接丢弃；受影响产品从 configurations 的 cpeMatch 提取（CPE 2.3
 * URI 的 vendor/product 段），去重后随记录走。
 *
 * CVSS 选取顺序：cvssMetricV31 → cvssMetricV30 → cvssMetricV2，组内优先
 * type=Primary 条目。老记录（2015 前）可能只有 V2 甚至无 CVSS——解析层
 * 不报错，缺省为 null，查询侧按 N/A 呈现。
 */

/** CVE 编号形状（官方格式 CVE-YYYY-NNNN，至少 4 位序列号）。 */
const CVE_ID_RE = /^CVE-\d{4}-\d{4,}$/i;

/** 受影响产品（CPE 2.3 的 vendor/product 段）。 */
export interface IntelProduct {
  vendor: string;
  product: string;
}

/** 单条 CVE 的结构化记录（字段级摘要，见文件头注释）。 */
export interface ParsedCve {
  id: string;
  description: string;
  cvssScore: number | null;
  cvssVector: string | null;
  published: string | null;
  modified: string | null;
  products: IntelProduct[];
}

/** 分页元数据（sync 的分页游标数据源）。 */
export interface NvdPageMeta {
  totalResults: number;
  startIndex: number;
  resultsPerPage: number;
}

export interface ParsedNvdPage {
  meta: NvdPageMeta;
  cves: ParsedCve[];
}

// ===== 类型收窄辅助（unknown 进、定型出，eslint no-explicit-any 约束下
//       用最小接口逐层剥洋葱，不信任任何外部形状） =====

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

// ===== CPE 解析 =====

/**
 * CPE 2.3 criteria 切段：冒号是分隔符，但 vendor/product 可能含转义冒号
 * （`\:`），先按转义感知切分再解转义（`\x` → `x`）。单测覆盖转义场景。
 */
function splitCpe(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let escaped = false;
  for (const ch of s) {
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === ':') {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  // 末尾悬空反斜杠按字面保留（宽容处理畸形 criteria）
  if (escaped) cur += '\\';
  out.push(cur);
  return out;
}

/**
 * 从 CPE 2.3 criteria 提取 vendor/product（`cpe:2.3:a:vendor:product:...`）。
 * 形状不符返回 null（调用方跳过该条，不报错）。
 */
export function parseCpeCriteria(criteria: string): IntelProduct | null {
  const parts = splitCpe(criteria);
  if (parts.length < 6 || parts[0] !== 'cpe' || parts[1] !== '2.3') return null;
  return { vendor: parts[3] || '*', product: parts[4] || '*' };
}

// ===== 字段提取 =====

/** 描述：优先英文（lang=en），回落第一条非空值。 */
function pickDescription(descriptionsRaw: unknown): string {
  const list = asArray(descriptionsRaw)
    .map(asRecord)
    .filter((d): d is Record<string, unknown> => d !== null);
  if (list.length === 0) return '';
  const en = list.find((d) => typeof d.lang === 'string' && d.lang.toLowerCase() === 'en');
  const chosen = en ?? list[0];
  return asString(chosen?.value)?.trim() ?? '';
}

/** CVSS：V31 → V30 → V2 降级选取，组内优先 Primary。 */
function pickCvss(metricsRaw: unknown): { cvssScore: number | null; cvssVector: string | null } {
  const metrics = asRecord(metricsRaw) ?? {};
  for (const key of ['cvssMetricV31', 'cvssMetricV30', 'cvssMetricV2']) {
    const list = asArray(metrics[key])
      .map(asRecord)
      .filter((m): m is Record<string, unknown> => m !== null);
    if (list.length === 0) continue;
    const primary = list.find((m) => typeof m.type === 'string' && m.type.toLowerCase() === 'primary') ?? list[0];
    const data = asRecord(primary?.cvssData);
    const score = asNumber(data?.baseScore);
    const vector = asString(data?.vectorString);
    if (score !== null || vector !== null) return { cvssScore: score, cvssVector: vector };
  }
  return { cvssScore: null, cvssVector: null };
}

/** 受影响产品：configurations[].nodes[].cpeMatch[] → CPE 提取 + 去重。 */
function collectProducts(configurationsRaw: unknown): IntelProduct[] {
  const seen = new Set<string>();
  const out: IntelProduct[] = [];
  for (const config of asArray(configurationsRaw)) {
    const cfg = asRecord(config);
    for (const node of asArray(cfg?.nodes)) {
      const n = asRecord(node);
      for (const match of asArray(n?.cpeMatch)) {
        const m = asRecord(match);
        // vulnerable=false 的条目（如"不受影响的版本"）不算受影响产品
        if (m?.vulnerable === false) continue;
        const criteria = asString(m?.criteria);
        if (!criteria) continue;
        const product = parseCpeCriteria(criteria);
        if (!product) continue;
        const key = `${product.vendor}\u0000${product.product}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push(product);
        }
      }
    }
  }
  return out;
}

// ===== 入口 =====

/**
 * 解析一页 NVD API 2.0 响应。缺失 id 或 id 形状非法的条目跳过；
 * 顶层不是对象（404 错误体等）→ 空页。绝不 throw——网络与重试的
 * 错误处理在 sync.ts，这里只做宽容抽取。
 */
export function parseNvdPage(json: unknown): ParsedNvdPage {
  const root = asRecord(json);
  const meta: NvdPageMeta = {
    totalResults: asNumber(root?.totalResults) ?? 0,
    startIndex: asNumber(root?.startIndex) ?? 0,
    resultsPerPage: asNumber(root?.resultsPerPage) ?? 0,
  };
  const cves: ParsedCve[] = [];
  for (const item of asArray(root?.vulnerabilities)) {
    const vuln = asRecord(item);
    const cve = asRecord(vuln?.cve);
    const id = asString(cve?.id);
    if (!id || !CVE_ID_RE.test(id)) continue;
    const { cvssScore, cvssVector } = pickCvss(cve?.metrics);
    cves.push({
      id: id.toUpperCase(),
      description: pickDescription(cve?.descriptions),
      cvssScore,
      cvssVector,
      published: asString(cve?.published),
      modified: asString(cve?.lastModified),
      products: collectProducts(cve?.configurations),
    });
  }
  return { meta, cves };
}
