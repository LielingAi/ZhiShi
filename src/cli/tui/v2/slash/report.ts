/**
 * /export [sanitize] — 1.2.0 研究交付：一键出报告（design 1.2.0）。
 * 服务端异步协调（组装→敏感扫描→一次边界批准→证据回收→LLM 填肉→落盘）；
 * 批准期间这个 adminPost 一直 pending，红色越界模态走 chat:boundary-ask
 * 通道自然弹出（同 /extract 的 HTTP pending 模式）。SidecarClient 无请求
 * 超时，长耗时（叙述 loop/scp）由服务端自己兜底，这里不做额外超时。
 */

import type { SlashContext } from './types';

interface ExportResult {
  success?: boolean;
  error?: string;
  data?: {
    reportDir?: string;
    evidenceCount?: number;
    degraded?: string[];
    sanitized?: boolean;
  };
}

export async function runExport(ctx: SlashContext, arg: string): Promise<void> {
  const word = arg.trim();
  if (word && word !== 'sanitize') {
    ctx.pushBlock({ kind: 'error', text: '用法：/export [sanitize]' });
    return;
  }
  const sanitize = word === 'sanitize';
  ctx.pushBlock({ kind: 'divider', label: `正在组装报告${sanitize ? '（脱敏版）' : ''}…`, tone: 'info' });
  const res = await ctx.client
    .adminPost<ExportResult>('report/export', { workspace: ctx.workspace, ...(sanitize ? { sanitize } : {}) })
    .catch((err): ExportResult => ({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }));
  if (res.success === false) {
    ctx.pushBlock({ kind: 'error', text: `导出失败：${res.error}` });
    return;
  }
  const data = res.data ?? {};
  const degraded = data.degraded ?? [];
  const parts = [`证据 ${data.evidenceCount ?? 0} 个`];
  if (degraded.length > 0) parts.push(`降级 ${degraded.length} 项`);
  if (data.sanitized) parts.push('已脱敏');
  ctx.pushBlock({
    kind: 'divider',
    label: `报告已导出：${data.reportDir ?? 'output/reports/'}（${parts.join('，')}）`,
    tone: 'info',
  });
  for (const item of degraded) {
    ctx.pushBlock({ kind: 'divider', label: `降级：${item}`, tone: 'info' });
  }
}
