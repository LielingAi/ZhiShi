/**
 * SSE 生命周期 hook：挂载即端口发现 + 建连，卸载即清理。
 * 实际逻辑都在 store（init / dispose），这里只是 React 装配。
 */

import { useEffect } from 'react';

import { useGuiStore } from '../store/useGuiStore';

export function useSse(): void {
  const init = useGuiStore((s) => s.init);
  const dispose = useGuiStore((s) => s.dispose);

  useEffect(() => {
    init();
    return () => {
      dispose();
    };
  }, [init, dispose]);
}
