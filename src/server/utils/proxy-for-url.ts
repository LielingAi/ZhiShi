/**
 * Proxy URL resolution for outbound provider probes (M4c: 自 openai-bridge
 * handler.ts 迁入——bridge 已删除,代理解析与 bridge 无关)。
 *
 * 读标准代理环境变量(https_proxy/HTTPS_PROXY/http_proxy/HTTP_PROXY/
 * ALL_PROXY),尊重 no_proxy(精确主机或 .后缀匹配,'*' 全豁免)。
 * 返回 undefined = 该 URL 不走代理。
 */
export function getProxyForUrl(url: string): string | undefined {
  const proxy = process.env.https_proxy || process.env.HTTPS_PROXY
    || process.env.http_proxy || process.env.HTTP_PROXY
    || process.env.ALL_PROXY || process.env.all_proxy;
  if (!proxy) return undefined;

  const noProxy = process.env.no_proxy || process.env.NO_PROXY || '';
  if (noProxy === '*') return undefined;
  if (noProxy) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      const excluded = noProxy.split(',').some((p) => {
        const pattern = p.trim().toLowerCase();
        return host === pattern || host.endsWith(`.${pattern}`);
      });
      if (excluded) return undefined;
    } catch { /* invalid URL, skip no_proxy check */ }
  }

  return proxy;
}
