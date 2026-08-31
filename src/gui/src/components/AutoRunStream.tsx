/**
 * 1.4.6 auto loop 左屏过程观察模式——「左过程右成果」分屏语义在 auto-run
 * 下的左屏补全（实机实证：run 活跃时左屏只有「等待第一条消息」,过程不可见）。
 *
 * run 的 loop 会话走 invoke 无广播通道（1.4.1 设计——不进交互聊天流），
 * 所以左屏观察走**轮询只读回放**：每 5s 拉一次 run 的 wire transcript
 * （轨迹按轮次落盘——turn 完成才持久化，观察粒度 = 已完成轮次）。
 * run 结束/无 run 时主区回落到交互 Stream（App.tsx 的 MainArea 切换）。
 */

import { useEffect, useRef, useState } from 'react';
import type React from 'react';

import { getSettingsClient, useGuiStore } from '../store/useGuiStore';
import * as api from '../client/api';
import { buildHistorySession } from '../model/history';
import type { StreamItem } from '../model/blocks';
import { TurnView } from './TurnView';

function ObsItem({ item }: { item: StreamItem }): React.JSX.Element {
  switch (item.kind) {
    case 'turn':
      return <TurnView turn={item} />;
    case 'divider':
      return (
        <div className="divider-line">
          <span>{item.text}</span>
        </div>
      );
    case 'error':
      return (
        <div className="error-line">
          <span className="err-mark">✗</span> {item.text}
        </div>
      );
  }
}

const POLL_MS = 5000;

export function AutoRunStream(): React.JSX.Element {
  const autoRun = useGuiStore((s) => s.autoRun);
  const loopId = autoRun?.loopSessionId;
  const [items, setItems] = useState<StreamItem[]>([]);
  const parentRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    if (!loopId) return;
    let cancelled = false;
    const load = async () => {
      const c = getSettingsClient();
      if (!c) return;
      try {
        const res = await api.fetchSessionWire(c, loopId);
        if (cancelled || !res.success) return;
        setItems(buildHistorySession(res.messages ?? []).items);
      } catch {
        /* 静默——下一轮再试（run 首 turn 未落盘/瞬态错误都正常） */
      }
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [loopId]);

  // 底部吸附（接近底部时新块自动滚到底——与 Stream 同口径）。
  useEffect(() => {
    const el = parentRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [items.length]);

  return (
    <div
      className="stream ars-stream"
      ref={parentRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
      }}
    >
      <div className="ars-banner">
        ⚡ auto loop 观察模式（只读）· {autoRun?.name ?? ''} · 轨迹按轮次落盘刷新（{POLL_MS / 1000}s 轮询）
      </div>
      {items.length === 0 && (
        <div className="ready-line">run 的轨迹将在首轮结束后出现——实时状态看下方观察卡与右屏研究档案</div>
      )}
      {items.map((item) => (
        <ObsItem item={item} key={item.id} />
      ))}
    </div>
  );
}
