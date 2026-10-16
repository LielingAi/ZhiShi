/**
 * 正门（V4-S4 决策①④ → S4.1 全幅启动台）：EnvSidebar 完全退出常驻 chrome
 * 后的唯一环境管理面。组件本体（三组分组/准入闸/⋯菜单/镜像行/新建/设置）
 * 继续零改动——外壳 + 布局 CSS 解决版面饱满度（WREN 真机反馈：居中窄列
 * 留白太多）：
 *
 *   横幅带：品牌 + 大标题 + 环境计数/日期 + 主按钮「＋新建环境」+
 *           「→ 进入工作区」（有环境时）
 *   中部：  EnvSidebar 原样挂载——.eb-scroll 在 gate 上下文被改写成
 *           响应式网格（auto-fit minmax 340px），每组一张横铺卡片
 *   底部：  操作提示条（照实际入口写）+ EnvSidebar 自带底栏（新建/设置）
 */

import { useEffect, useState } from 'react';
import type React from 'react';

import { useGuiStore } from '../store/useGuiStore';
import { EnvSidebar } from './EnvSidebar';

/** 横幅右侧的本地时钟（M-D HH:MM，1s tick——与工作区 menubar 时钟同族）。 */
function GateClock(): React.JSX.Element {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    <span className="gate-meta" title="环境总数 · 本地时间">
      {now.getMonth() + 1}-{now.getDate()} {pad(now.getHours())}:{pad(now.getMinutes())}
    </span>
  );
}

export function GatePage(): React.JSX.Element {
  const currentEnvKey = useGuiStore((s) => s.currentEnvKey);
  const envCount = useGuiStore((s) => s.envs.length);
  const setPage = useGuiStore((s) => s.setPage);
  const openNewEnv = useGuiStore((s) => s.openNewEnv);

  return (
    <div className="gate-wrap">
      <header className="gate-banner">
        <div className="gate-brand">
          <span className="gate-logo">◣ zhishi</span>
          <span className="gate-heading">选择工作环境</span>
          <span className="gate-sub">
            研究只发生在环境内——选中即进工作区；中途换环境走 Ctrl+K → use
          </span>
        </div>
        <div className="gate-banner-right">
          <span className="gate-meta">环境 {envCount} ·</span>
          <GateClock />
          {currentEnvKey && (
            <button
              className="btn small gate-enter"
              title="回当前环境的工作区（Esc 同语义）"
              onClick={() => setPage('chat')}
            >
              → 进入工作区（{currentEnvKey}）
            </button>
          )}
          {/* 正门第一动作：新建环境——主按钮放在横幅带右侧（底栏的同名
              入口组件自带，两处不算重复：底栏是列表收尾，横幅是着陆第一动作）。 */}
          <button className="btn primary" onClick={() => openNewEnv()}>
            ＋ 新建环境
          </button>
        </div>
      </header>
      <div className="gate-col">
        <EnvSidebar />
      </div>
      <footer className="gate-foot">
        <span>点行即进工作区 · 行尾 ⋯ 菜单 = 启停 / 重建 / 重置 / 补齐 / 详情 / 删除</span>
        <span>Ctrl+K → use 切环境 · /gate 唤正门 · Esc 返回</span>
      </footer>
    </div>
  );
}
