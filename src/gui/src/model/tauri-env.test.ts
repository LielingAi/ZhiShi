import { describe, expect, it } from 'vitest';

import { isTauriRuntime } from './tauri-env';

describe('isTauriRuntime（Tauri 环境探测，纯函数）', () => {
  it('存在 __TAURI_INTERNALS__ → true', () => {
    expect(isTauriRuntime({ __TAURI_INTERNALS__: {} })).toBe(true);
  });

  it('缺席 → false（浏览器降级通道）', () => {
    expect(isTauriRuntime({})).toBe(false);
    expect(isTauriRuntime(undefined)).toBe(false);
  });

  it('显式 null/undefined 值不误判', () => {
    expect(isTauriRuntime({ __TAURI_INTERNALS__: null })).toBe(false);
    expect(isTauriRuntime({ __TAURI_INTERNALS__: undefined })).toBe(false);
  });
});
