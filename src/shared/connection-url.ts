/**
 * 团队大脑 server URL 归一化的单一事实源（2.0 audit D3：GUI/CLI 双端
 * 逐字镜像收敛）。
 *
 * 语义（两端历史契约）：
 *   - trim；空串抛错
 *   - 缺 scheme 补 http://
 *   - 剥尾部斜杠（多次）
 *   - new URL 仅作形态校验——解析结果不回用（保留原始 host 写法，
 *     打到 UI/stderr 的 URL 应与用户输入一致）
 */

export function normalizeServerUrl(raw: string): string {
  let s = raw.trim();
  if (!s) throw new Error('empty server URL');
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) s = `http://${s}`;
  s = s.replace(/\/+$/, '');
  new URL(s);
  return s;
}
