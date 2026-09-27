/**
 * 文本小工具（包内 vendored 副本）。
 * 单一事实源在 u-disk 的 src/shared/utils.ts::stripBom——此处是包自包含所需的镜像。
 */

/** 剥 UTF-8 BOM（磁盘上带 BOM 的 jsonl 直接 JSON.parse 会炸）。 */
export function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}
