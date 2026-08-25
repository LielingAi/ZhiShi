/**
 * 输入区：chips（@ 引用）+ textarea + 发送按钮。
 *
 * 键盘语义：
 *   Enter（无 overlay）    → 发送；busy 时同样 POST /chat/send（服务端
 *                            裁决进 steering 队列——纠偏语义），按钮变「纠偏」。
 *   Shift+Enter            → 换行
 *   ↑（空输入）            → 历史 overlay
 *   Ctrl+R                 → 历史 overlay
 *   `/` 前缀 / Ctrl+K      → 命令 overlay；`@` 前缀 → 引用 overlay
 *   Esc                    → 交给全局单处理器（useEsc），这里不拦截
 */

import { useEffect, useRef, useState } from 'react';
import type React from 'react';

import { selectCurrentSession, useGuiStore } from '../store/useGuiStore';

export function InputArea(): React.JSX.Element {
  const [value, setValue] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);

  const refs = useGuiStore((s) => s.refs);
  const removeRef = useGuiStore((s) => s.removeRef);
  const send = useGuiStore((s) => s.send);
  const busy = useGuiStore((s) => selectCurrentSession(s).phase === 'running');
  const overlay = useGuiStore((s) => s.overlay);
  const openOverlay = useGuiStore((s) => s.openOverlay);
  const closeOverlay = useGuiStore((s) => s.closeOverlay);
  const inputFill = useGuiStore((s) => s.inputFill);
  const envLabel = useGuiStore((s) => s.currentEnvKey || 'host');

  // 历史 overlay 选中 → 回填输入框。
  useEffect(() => {
    if (inputFill) {
      setValue(inputFill.text);
      taRef.current?.focus();
    }
  }, [inputFill]);

  const doSend = () => {
    const text = value.trim();
    if (!text) return;
    setValue('');
    void send(text);
  };

  const onInput = (raw: string) => {
    setValue(raw);
    const ta = taRef.current;
    if (ta) {
      ta.style.height = '22px';
      ta.style.height = `${Math.min(ta.scrollHeight, 130)}px`;
    }
    const m = /@([\w.-]*)$/.exec(raw);
    if (m) {
      openOverlay('at', m[1]);
      return;
    }
    if (raw.startsWith('/')) {
      openOverlay('slash', raw.slice(1));
      return;
    }
    if (overlay && (overlay.kind === 'at' || overlay.kind === 'slash')) closeOverlay();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // overlay 开着时输入区不抢键：导航/回车/取消交给全局处理器。
    if (overlay) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSend();
    } else if (e.key === 'ArrowUp' && !value) {
      e.preventDefault();
      openOverlay('history', '');
    } else if (e.key === 'r' && e.ctrlKey) {
      e.preventDefault();
      openOverlay('history', '');
    } else if (e.key === 'k' && e.ctrlKey) {
      e.preventDefault();
      openOverlay('slash', '');
    }
  };

  return (
    <div className="input-area">
      {refs.length > 0 && (
        <div className="input-chips">
          {refs.map((r, i) => (
            <span className="chip" key={`${r.type}-${'id' in r ? r.id : i}`}>
              {'id' in r ? r.id : 'name' in r ? r.name : r.path}
              <span className="x" onClick={() => removeRef(i)}>✕</span>
            </span>
          ))}
        </div>
      )}
      <div className="input-box">
        <textarea
          ref={taRef}
          rows={1}
          placeholder={`向 ${envLabel} 提问…（/ 命令 · @ 引用 · ${busy ? 'Enter 纠偏' : 'Enter 发送'}）`}
          value={value}
          onChange={(e) => onInput(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          className="send-btn"
          title={busy ? '发送纠偏（turn 运行中，进 steering 队列）' : '发送'}
          onClick={doSend}
        >
          {busy ? '↳' : '↑'}
        </button>
      </div>
    </div>
  );
}
