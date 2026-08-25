/**
 * 全局 toast（底部居中，自动消失）。
 */

import { useEffect } from 'react';
import type React from 'react';

import { useGuiStore } from '../store/useGuiStore';

export function Toast(): React.JSX.Element | null {
  const toast = useGuiStore((s) => s.toast);
  const nonce = useGuiStore((s) => s.toastNonce);
  const clear = useGuiStore((s) => s.clearToast);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(clear, 2200);
    return () => clearTimeout(timer);
  }, [toast, nonce, clear]);

  if (!toast) return null;
  return <div className="toast show">{toast}</div>;
}
