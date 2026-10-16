/**
 * V4-S3 命令中枢（Ctrl+K 面板，pal-*——形态照 v4 原型 #palette）：顶部
 * › 输入行 + 中部候选列表（目录态按组分节）+ 底部键位提示行。
 *
 * 一门两窗：与输入行 `/` overlay 共用 model/command-palette 候选推导与
 * execSlashCommand 执行出口；本组件只管渲染与键位。
 *
 * 键位自管（capture 先于 useEsc）：useEsc 对 Escape 是**无条件**转
 * store.esc() 的——palette 不在 Esc 链里，不拦的话 busy 时 Esc 会直达
 * 「中断 turn」（真事故，不只是双吃）。↑↓/Enter/Tab 同理拦下，窗口
 * capture 相 stopPropagation，bubble 相的 useEsc/输入区都看不到这些键。
 */

import { Fragment, useEffect, useRef } from 'react';
import type React from 'react';

import { useGuiStore } from '../store/useGuiStore';

export function CommandPalette(): React.JSX.Element | null {
  const open = useGuiStore((s) => s.paletteOpen);
  const text = useGuiStore((s) => s.paletteText);
  const sel = useGuiStore((s) => s.paletteSel);
  const items = useGuiStore((s) => s.paletteItems);
  const setPaletteText = useGuiStore((s) => s.setPaletteText);
  const movePaletteSel = useGuiStore((s) => s.movePaletteSel);
  const pickPalette = useGuiStore((s) => s.pickPalette);
  const closePalette = useGuiStore((s) => s.closePalette);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      // 面板自管五键；全部 preventDefault + stopPropagation——前者挡输入框
      // 默认行为（Tab 移焦/Enter 提交），后者让 bubble 相的 useEsc 与
      // InputArea 看不到（一门两窗，互不串线）。
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closePalette();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        movePaletteSel(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        movePaletteSel(-1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        pickPalette();
      } else if (e.key === 'Tab') {
        // 同 slash overlay Tab 语义：回填继续输参（pickPalette 内部按
        // 候选 kind 分流——动词未带参回填，其余执行）。
        e.preventDefault();
        e.stopPropagation();
        pickPalette();
      }
    };
    // capture=true：window 上 useEsc 的监听挂在 bubble 相，capture 先拦先止。
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, closePalette, movePaletteSel, pickPalette]);

  if (!open) return null;

  return (
    <div className="pal-backdrop" onClick={closePalette}>
      <div className="pal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="pal-input-row">
          <span className="pal-mark">›</span>
          <input
            ref={inputRef}
            className="pal-input"
            value={text}
            onChange={(e) => setPaletteText(e.target.value)}
            placeholder="动词或 /命令——resume 切线 · kill 终止战役 · snapshot 打快照…"
            spellCheck={false}
          />
        </div>
        <div className="pal-list">
          {items.length === 0 && <div className="pal-empty">无匹配——清空输入回动词目录</div>}
          {items.map((it, i) => (
            <Fragment key={`${it.kind}:${it.runCmdline}:${i}`}>
              {/* 分节头：group 变化处画一次（「最近」+ 动词目录各组）。 */}
              {it.group && (i === 0 || items[i - 1].group !== it.group) && (
                <div className="pal-group-label">{it.group}</div>
              )}
              <div
                className={`pal-item${i === sel ? ' sel' : ''}${it.kind === 'history' ? ' hist' : ''}`}
                onClick={() => pickPalette(i)}
              >
                <span className="pal-title">{it.title}</span>
                {it.detail && <span className="pal-detail">{it.detail}</span>}
                {it.tag && <span className="pal-tag">{it.tag}</span>}
              </div>
            </Fragment>
          ))}
        </div>
        <div className="pal-foot">
          <span>↑↓ 选择</span>
          <span>Enter 执行</span>
          <span>Tab 回填</span>
          <span>Esc 关闭</span>
        </div>
      </div>
    </div>
  );
}
