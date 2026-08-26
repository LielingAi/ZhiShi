/**
 * Tauri 运行时探测（1.3.6，纯函数）：文件导入的通道分流依据。
 *
 * Tauri 2 webview 里 `window.__TAURI_INTERNALS__` 存在（invoke IPC 桥），
 * 纯浏览器环境缺席。探测只做环境判定，不触发任何 IPC——
 * 导入逻辑据此在「dialog 选择器」与「HTML 文件选择 + FileReader」间分流：
 *   - skills 目录导入：Tauri 走 dialog（open directory:true 拿绝对路径，
 *     透传 /api/skill/import-folder）；浏览器回落 webkitdirectory（拿不到
 *     绝对路径 → 引导 CLI）。
 *   - expert 文件导入：内容读取必须拿到 File 对象（tauri-plugin-fs 不在
 *     范围），Tauri 与浏览器统一走 HTML input + FileReader（WebView2 原生
 *     支持文件选择，双环境同一条通道）。
 */

export interface TauriProbeWindow {
  __TAURI_INTERNALS__?: unknown;
}

export function isTauriRuntime(win?: TauriProbeWindow): boolean {
  const w = win ?? (typeof window !== 'undefined' ? (window as TauriProbeWindow) : undefined);
  return !!w && w.__TAURI_INTERNALS__ != null;
}
