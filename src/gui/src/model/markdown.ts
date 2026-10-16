/**
 * 消息 markdown 判定纯函数（V4-S7 消息渲染优化批）。
 *
 * assistant 正文双轨渲染（components/Markdown.tsx）：含 markdown 语法 →
 * ReactMarkdown 渲染子集；不含 → 维持 pre-wrap 纯文本（现状兜底）。判定
 * 必须是保守的——宁可漏判成纯文本（源码直出、零损失），不可误判把普通
 * 多行文本（日志/报错/对齐文本）拆成段落丢换行。
 *
 * 纯函数：不 import React / markdown 库；单测守住漏判/误判两端。
 */

/**
 * 文本是否含 markdown 结构语法。只认「块级强信号」+ 少量行内强信号：
 *   块级：ATX 标题 / -+* 列表 / 有序列表 / 引用 / 代码围栏 / GFM 表格行
 *   行内：行内 code / 加粗 / 链接（ fenced code 里的内容不参与——围栏
 *         本身已先命中）
 * 像 ** 落单、单独的 *（乘号/通配）一律不算，避免误伤技术类纯文本。
 */
export function looksLikeMarkdown(text: string): boolean {
  if (!text) return false;
  // 块级强信号（行首锚定）。
  if (/^#{1,6}\s+\S/m.test(text)) return true;
  if (/^\s*[-*+]\s+\S/m.test(text)) return true;
  if (/^\s*\d+\.\s+\S/m.test(text)) return true;
  if (/^>\s?/m.test(text)) return true;
  if (/^```/m.test(text)) return true;
  if (/^\|.*\|\s*$/m.test(text)) return true;
  // 行内强信号（code/加粗/链接至少出现一次）。
  if (/`[^`\n]+`/.test(text)) return true;
  if (/\*\*[^*\n]+\*\*/.test(text)) return true;
  if (/\[[^\]\n]+\]\([^)\n]+\)/.test(text)) return true;
  return false;
}
