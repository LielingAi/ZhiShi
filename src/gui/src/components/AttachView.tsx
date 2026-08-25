/**
 * attach 占位视图（MVP）：主区接管布局照 v19，命令执行未接 term API。
 */

import { useState } from 'react';
import type React from 'react';

import { useGuiStore } from '../store/useGuiStore';

export function AttachView(): React.JSX.Element {
  const envKey = useGuiStore((s) => s.currentEnvKey);
  const setPage = useGuiStore((s) => s.setPage);
  const showToast = useGuiStore((s) => s.showToast);
  const [cmd, setCmd] = useState('');
  const [hist, setHist] = useState<string[]>([]);

  return (
    <div className="attach-view show">
      <div className="attach-head">
        <span className="ah-env">◈ {envKey || '未选择环境'}</span>
        <span className="ah-hint">
          已接管 shell · <kbd>exit</kbd> 或 <kbd>Esc</kbd> 返回会话流（MVP 占位，未接 term API）
        </span>
        <button className="ah-close" onClick={() => setPage('chat')}>✕</button>
      </div>
      <div className="attach-term">
        <div className="at-welcome">
          已连接到 {envKey || '…'}（占位演示）<br />
          输入 exit 返回会话流（会话流在后台继续接收）
        </div>
        {hist.map((h, i) => (
          <div key={i}>
            <div className="at-cmd">{h}</div>
            <div className="at-out">（命令未执行——MVP 占位）</div>
          </div>
        ))}
      </div>
      <div className="attach-input-line">
        <span className="at-prompt">root@{envKey ? envKey.split('@')[0] : 'host'}:#</span>
        <input
          className="attach-input"
          autoComplete="off"
          spellCheck={false}
          placeholder="输入命令…（exit 返回）"
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const c = cmd.trim();
            if (!c) return;
            setHist((h) => [...h, c]);
            setCmd('');
            if (c === 'exit' || c === 'logout') {
              setPage('chat');
            } else {
              showToast(`${c}：MVP 占位，未接 term API`);
            }
          }}
        />
      </div>
    </div>
  );
}
