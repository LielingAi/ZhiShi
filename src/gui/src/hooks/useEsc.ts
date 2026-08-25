/**
 * Esc 链全局单处理器（修正项：不用 v19 的双处理器叠加）。
 *
 * 唯一一个 window keydown 监听：Escape → store.esc()（escAction 纯函数
 * 定优先级，见 model/esc-chain.ts）。overlay 的方向键/回车导航也在这里
 * 处理（输入区的 keydown 只在 overlay 关闭时才管 Enter/↑/Ctrl+R）。
 */

import { useEffect } from 'react';

import { useGuiStore } from '../store/useGuiStore';

export function useEsc(): void {
  const overlay = useGuiStore((s) => s.overlay);
  const esc = useGuiStore((s) => s.esc);
  const moveOverlay = useGuiStore((s) => s.moveOverlay);
  const pickOverlay = useGuiStore((s) => s.pickOverlay);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        esc();
        return;
      }
      if (!overlay) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveOverlay(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveOverlay(-1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        pickOverlay(overlay.sel);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overlay, esc, moveOverlay, pickOverlay]);
}
