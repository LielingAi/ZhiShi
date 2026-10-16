/**
 * assistant 正文 Markdown 渲染（V4-S7）——双轨：
 *   looksLikeMarkdown → ReactMarkdown（remark-gfm）渲染子集；
 *   否则 → .md-plain 纯文本 pre-wrap（现状兜底，字阶与 md 态统一）。
 *
 * 仪器感定制映射（components override，不用默认 HTML 样式）：
 *   h1-h3 压成紧凑小节标题（左 accent 竖条）、列表悬挂缩进、行内 code =
 *   深色 chip、代码块 = 工具输出同款深色面板（左紫竖条，家族一致）、
 *   表格紧凑线框、链接 accent、图片降级为纯链接（不渲染图）。
 *
 * 流式容错：解析器对未闭合围栏/落单行内标记天然容错（渲染字面量，不
 * 崩）；流式光标 ▌ 由 TurnView 作为 .md 的兄弟节点渲染，不经 markdown
 * 管线——中间态不会被解析器吞掉或移位。
 */

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type React from 'react';

import { looksLikeMarkdown } from '../model/markdown';

export function Markdown({ text }: { text: string }): React.JSX.Element {
  if (!looksLikeMarkdown(text)) {
    return <div className="md md-plain">{text}</div>;
  }
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // 标题三级合一：小节标题（仪器感不兴大字——信息密度优先）。
          h1: ({ children }) => <div className="md-h">{children}</div>,
          h2: ({ children }) => <div className="md-h">{children}</div>,
          h3: ({ children }) => <div className="md-h">{children}</div>,
          h4: ({ children }) => <div className="md-h md-h4">{children}</div>,
          h5: ({ children }) => <div className="md-h md-h4">{children}</div>,
          h6: ({ children }) => <div className="md-h md-h4">{children}</div>,
          p: ({ children }) => <p className="md-p">{children}</p>,
          ul: ({ children }) => <ul className="md-ul">{children}</ul>,
          ol: ({ children }) => <ol className="md-ol">{children}</ol>,
          li: ({ children }) => <li className="md-li">{children}</li>,
          blockquote: ({ children }) => <blockquote className="md-quote">{children}</blockquote>,
          // 行内 code 由 pre 包裹的 code 是代码块（在 pre override 内消化）。
          code: ({ className, children }) => (
            <code className={`md-code ${className ?? ''}`}>{children}</code>
          ),
          pre: ({ children }) => <pre className="md-pre">{children}</pre>,
          a: ({ href, children }) => (
            <a className="md-a" href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          hr: () => <hr className="md-hr" />,
          table: ({ children }) => <table className="md-table">{children}</table>,
          th: ({ children }) => <th className="md-th">{children}</th>,
          td: ({ children }) => <td className="md-td">{children}</td>,
          // 图片不渲染（仪器面板不嵌图）：降级为 accent 链接，可看可点。
          img: ({ src, alt }) => (
            <a className="md-a" href={src} target="_blank" rel="noreferrer">
              🖼 {alt || src}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
