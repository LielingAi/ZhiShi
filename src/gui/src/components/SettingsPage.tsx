/**
 * 设置占位页（MVP）：导航骨架照 v19，内容只实现「外观」（主题切换入口
 * 占位——浅色不实现）与「关于」；其余页签为占位文案。
 */

import { useState } from 'react';
import type React from 'react';

import { useGuiStore } from '../store/useGuiStore';

const NAV = [
  { id: 'model', icon: '◇', label: '模型' },
  { id: 'skills', icon: '▤', label: 'Skills' },
  { id: 'intel', icon: '◈', label: '情报' },
  { id: 'expert', icon: '◇', label: '专家知识' },
  { id: 'research', icon: '✎', label: '研究记录' },
  { id: 'appearance', icon: '◐', label: '外观' },
  { id: 'about', icon: 'ⓘ', label: '关于' },
] as const;

export function SettingsPage(): React.JSX.Element {
  const [pg, setPg] = useState<string>('appearance');
  const setPage = useGuiStore((s) => s.setPage);
  const showToast = useGuiStore((s) => s.showToast);

  return (
    <div className="settings-page show">
      <div className="settings-head">
        <button className="sh-close" onClick={() => setPage('chat')}>✕</button>
      </div>
      <div className="set-main">
        <div className="set-nav">
          {NAV.map((n) => (
            <div
              className={`set-nav-item ${pg === n.id ? 'on' : ''}`}
              key={n.id}
              onClick={() => setPg(n.id)}
            >
              <span className="sn-ic">{n.icon}</span>
              {n.label}
            </div>
          ))}
        </div>
        <div className="set-content">
          {pg === 'appearance' && (
            <div className="set-group">
              <div className="sg-title">主题</div>
              <div className="set-row">
                <div>
                  <div className="sr-label">深色</div>
                  <div className="sr-desc">默认 · 长时间研究注视友好</div>
                </div>
                <div className="sr-control">
                  <span className="sr-status ok">✓ 当前</span>
                </div>
              </div>
              <div className="set-row">
                <div>
                  <div className="sr-label">浅色</div>
                  <div className="sr-desc">明亮环境使用（1.3.0 占位，后续实现）</div>
                </div>
                <div className="sr-control">
                  <button className="btn small" onClick={() => showToast('浅色主题占位——1.3.0 未实现')}>
                    应用
                  </button>
                </div>
              </div>
            </div>
          )}
          {pg === 'about' && (
            <div className="set-group">
              <div className="sg-title">zhishi · 执失</div>
              <div className="set-row">
                <div><div className="sr-label">版本</div></div>
                <div className="sr-control"><span className="sr-status">v1.3.0 GUI MVP</span></div>
              </div>
              <div className="set-row">
                <div><div className="sr-label">数据目录</div></div>
                <div className="sr-control"><span className="sr-status mono">~/.zhishi</span></div>
              </div>
            </div>
          )}
          {pg !== 'appearance' && pg !== 'about' && (
            <div className="set-group">
              <div className="sg-title">{NAV.find((n) => n.id === pg)?.label}</div>
              <div className="sr-desc">占位页——数据接口待后续迭代接入（模型选择在状态栏点击模型名）。</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
