/**
 * 2.1 — 报告下载登记表（内存，进程内）。
 *
 * 为什么不是通用静态文件服务：报告目录在工作区里，路径由请求方给就必然要
 * 防路径穿越。这里反过来——导出成功时由服务端登记「这一次产物」，下载只认
 * 随机 id。请求方拿不到任意路径的能力，也就没有穿越面。
 *
 * 生命周期：进程内、24 小时 TTL、最多 20 条（最旧的先淘汰）。sidecar 重启后
 * 失效——报告本体还在工作区，重新导出即可。
 */

import { randomBytes } from 'node:crypto';

export interface ReportArtifact {
  id: string;
  /** zip 的宿主绝对路径。 */
  path: string;
  reportDir: string;
  createdAt: number;
}

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 20;

const artifacts = new Map<string, ReportArtifact>();

function prune(now: number): void {
  for (const [id, art] of artifacts) {
    if (now - art.createdAt > TTL_MS) artifacts.delete(id);
  }
  while (artifacts.size > MAX_ENTRIES) {
    const oldest = artifacts.keys().next().value;
    if (oldest === undefined) break;
    artifacts.delete(oldest);
  }
}

/** 登记一次导出产物，返回下载 id（6 字节 hex）。 */
export function registerReportArtifact(input: { path: string; reportDir: string }, now: number = Date.now()): string {
  prune(now);
  let id = randomBytes(6).toString('hex');
  while (artifacts.has(id)) id = randomBytes(6).toString('hex');
  artifacts.set(id, { id, path: input.path, reportDir: input.reportDir, createdAt: now });
  return id;
}

export function getReportArtifact(id: string, now: number = Date.now()): ReportArtifact | undefined {
  prune(now);
  return artifacts.get(id);
}

/** 测试用：清空登记表。 */
export function resetReportArtifacts(): void {
  artifacts.clear();
}
