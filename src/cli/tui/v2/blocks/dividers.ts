/**
 * dividers (plan §2.3). The "系统告知" rows — interrupt divider, error bar,
 * background report, welcome card. Full-width mono lines with a single
 * accent color; never bubble cards.
 */

import { stringWidth } from '../../ansi';
import type { Span } from '../row-buffer';
import type { SemanticColor } from '../style';
import type { BackgroundBlock, DividerBlock, ErrorBlock } from '../types';

function now(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Optimistic interrupt label (appended on Esc press, before server answer). */
export function interruptLabel(): string {
  return `⏸ 已中断 ${now()}`;
}

/** Centered divider: `──── label ────` filling the width. */
export function renderDivider(block: DividerBlock, width: number): Span[][] {
  const label = block.follow ? `${block.label} · ${block.follow}` : block.label;
  const tone: SemanticColor = block.tone === 'interrupt' ? 'amber' : 'faint';
  const labelW = stringWidth(label);
  const side = Math.max(2, Math.floor((width - labelW - 2) / 2));
  const fillL = '─'.repeat(side);
  const fillR = '─'.repeat(Math.max(2, width - labelW - 2 - side));
  return [
    [
      { text: fillL + ' ', style: { fg: tone, dim: true } },
      { text: label, style: { fg: tone } },
      { text: ' ' + fillR, style: { fg: tone, dim: true } },
    ],
  ];
}

export function renderError(block: ErrorBlock, width: number): Span[][] {
  const text = block.text.length > width - 4 ? block.text.slice(0, width - 5) + '…' : block.text;
  return [
    [
      { text: '✗ ', style: { fg: 'red', bold: true } },
      { text, style: { fg: 'red' } },
    ],
    [],
  ];
}

export function renderBackground(block: BackgroundBlock): Span[][] {
  const spans: Span[] = [
    { text: '⛁ ', style: { fg: 'cyan' } },
    { text: block.summary, style: { fg: 'muted' } },
  ];
  if (block.switchHook) spans.push({ text: '  要我切过去吗？(y)', style: { fg: 'cyan' } });
  return [spans];
}

/**
 * Welcome card — the cold-start anchor (design §7.1). Three short lines:
 * product wordmark, the live env/model facts, and the four verbs to learn.
 */
export function renderWelcome(envName: string | undefined, envKind: string | undefined, model?: string): Span[][] {
  const envLabel = envName ? `${envName}${envKind ? `（${envKind}）` : ''}` : '未选择';
  const modelLine: Span[] = model
    ? [
        { text: ' · 模型 ', style: { fg: 'faint' as SemanticColor } },
        { text: model, style: { fg: 'muted' as SemanticColor } },
      ]
    : [];
  return [
    [],
    [{ text: '  ZhiShi 安全研究台', style: { fg: 'cyan' as SemanticColor, bold: true } }],
    [
      { text: '  环境 ', style: { fg: 'faint' as SemanticColor } },
      { text: envLabel, style: { fg: 'cyan' as SemanticColor } },
      ...modelLine,
    ],
    [
      { text: '  输入开始工作 · ', style: { fg: 'faint' as SemanticColor } },
      { text: '/', style: { fg: 'muted' as SemanticColor } },
      { text: ' 命令 · ', style: { fg: 'faint' as SemanticColor } },
      { text: '@', style: { fg: 'muted' as SemanticColor } },
      { text: ' 引用 · ', style: { fg: 'faint' as SemanticColor } },
      { text: 'Ctrl+L', style: { fg: 'muted' as SemanticColor } },
      { text: ' 帮助', style: { fg: 'faint' as SemanticColor } },
    ],
    [],
  ];
}

/**
 * 恢复会话提示行(有冷历史时替代欢迎卡,挂会话流末尾):
 * 「── 已恢复会话 · 环境 pwn-vm(vm) · kimi-k2 ──」。
 */
export function renderResumeHint(
  envName: string | undefined,
  envKind: string | undefined,
  model: string | undefined,
  width: number,
): Span[][] {
  const label = `已恢复会话 · ${envName ?? '未选择环境'}${envKind ? `(${envKind})` : ''}${model ? ` · ${model}` : ''}`;
  const labelW = stringWidth(label);
  const side = Math.max(2, Math.floor((width - labelW - 2) / 2));
  return [
    [],
    [
      { text: '─'.repeat(side) + ' ', style: { fg: 'faint' as SemanticColor, dim: true } },
      { text: label, style: { fg: 'cyan' as SemanticColor } },
      { text: ' ' + '─'.repeat(Math.max(2, width - labelW - 2 - side)), style: { fg: 'faint' as SemanticColor, dim: true } },
    ],
    [],
  ];
}
