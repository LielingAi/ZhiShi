/**
 * 2.1 — 报告下载登记表（report/artifacts.ts）unit tests。
 * 只认登记过的随机 id；TTL 与容量上限防止进程内无限增长。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { getReportArtifact, registerReportArtifact, resetReportArtifacts } from './artifacts';

beforeEach(() => resetReportArtifacts());

describe('report artifacts', () => {
  it('登记后可按 id 取回；id 是 12 位 hex', () => {
    const id = registerReportArtifact({ path: '/w/output/reports/r1/report.zip', reportDir: '/w/output/reports/r1' }, 1000);
    expect(id).toMatch(/^[a-f0-9]{12}$/);
    expect(getReportArtifact(id, 1001)).toEqual({
      id,
      path: '/w/output/reports/r1/report.zip',
      reportDir: '/w/output/reports/r1',
      createdAt: 1000,
    });
  });

  it('未知 id → undefined', () => {
    expect(getReportArtifact('aaaaaaaaaaaa', 1000)).toBeUndefined();
  });

  it('TTL 24h：过期后取不到', () => {
    const id = registerReportArtifact({ path: '/r.zip', reportDir: '/r' }, 1000);
    expect(getReportArtifact(id, 1000 + 24 * 60 * 60 * 1000)).toBeDefined();
    expect(getReportArtifact(id, 1000 + 24 * 60 * 60 * 1000 + 1)).toBeUndefined();
  });

  it('容量上限 20：最旧的先淘汰', () => {
    const ids: string[] = [];
    for (let i = 0; i < 21; i += 1) {
      ids.push(registerReportArtifact({ path: `/r${i}.zip`, reportDir: `/r${i}` }, 1000 + i));
    }
    expect(getReportArtifact(ids[0]!, 2000)).toBeUndefined();
    expect(getReportArtifact(ids[20]!, 2000)).toBeDefined();
  });
});
