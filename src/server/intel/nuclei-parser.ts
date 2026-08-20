/**
 * nuclei cves.json 解析层（1.1.4 情报横切 × pentest 域）。
 *
 * 上游是 projectdiscovery/nuclei-templates 根目录的 cves.json（约 2MB）：
 * NDJSON——每行一个对象 { ID, Info{...}, file_path }，同一 CVE 可占多行
 * （对应多个模板）。本层只摘 ID + file_path（模板正文在 GitHub，检索结果
 * 给 blob 链接，不拉 yaml 全文）。
 *
 * 容错语义与 exploitdb-parser 对齐：坏行跳过；整体解析出 0 条时 sync.ts
 * 保留旧数据（warnings 报告）。上游改版（字段改名/JSON 损坏）不会炸掉
 * update，也不会清空既有索引。
 */

/** 单条 nuclei 检测模板记录（CVE → 模板相对路径）。 */
export interface ParsedNucleiTemplate {
  cveId: string;
  templatePath: string;
}

/** CVE 编号形状（cves.json 的 ID 字段理论上是 CVE，防御性过滤）。 */
const CVE_ID_RE = /^CVE-\d{4}-\d{4,}$/i;

/**
 * 解析 cves.json 全文本（NDJSON）。逐行 JSON.parse：坏行/字段缺失的行
 * 跳过；同 (CVE, 路径) 去重（首行胜出）；ID 归一为大写。
 */
export function parseNucleiCvesJson(text: string): ParsedNucleiTemplate[] {
  const seen = new Set<string>();
  const out: ParsedNucleiTemplate[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // 坏行跳过（容忍上游损坏/改版）
    }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) continue;
    const row = obj as Record<string, unknown>;
    const id = typeof row.ID === 'string' ? row.ID.trim().toUpperCase() : '';
    const path = typeof row.file_path === 'string' ? row.file_path.trim() : '';
    if (!CVE_ID_RE.test(id) || !path) continue;
    const key = `${id}\u0000${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ cveId: id, templatePath: path });
  }
  return out;
}
