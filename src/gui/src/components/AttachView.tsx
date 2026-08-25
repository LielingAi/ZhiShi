/**
 * attach 视图（1.3.2 任务三「attach 页接真」）：挂接已运行环境，命令经
 * POST /api/admin/environment/exec 一次性执行（stdout + exitCode）。
 *
 * 边界说明：sidecar HTTP 面没有交互式 shell/pty 端点（Rust panel_api 的
 * term 路由只服务 CLI zhishi term），attach 页以「一次性命令执行」接真——
 * 每条命令单独 environment/exec，输出落屏。宿主会话（未锚定环境）无 shell
 * 可挂，提示先切换环境。exit/logout 或 Esc 返回会话流。
 */

import { useState } from 'react';
import type React from 'react';

import * as api from '../client/api';
import { getSettingsClient, useGuiStore } from '../store/useGuiStore';

interface AttachLine {
  kind: 'cmd' | 'out' | 'err';
  text: string;
}

export function AttachView(): React.JSX.Element {
  const envKey = useGuiStore((s) => s.currentEnvKey);
  const setPage = useGuiStore((s) => s.setPage);
  const showToast = useGuiStore((s) => s.showToast);
  const [cmd, setCmd] = useState('');
  const [lines, setLines] = useState<AttachLine[]>([]);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    const c = cmd.trim();
    if (!c || busy) return;
    if (c === 'exit' || c === 'logout') {
      setPage('chat');
      return;
    }
    if (!envKey) {
      showToast('attach：宿主会话没有环境 shell——先切换到运行中环境');
      return;
    }
    const client = getSettingsClient();
    if (!client) {
      showToast('未连接 sidecar');
      return;
    }
    setLines((l) => [...l, { kind: 'cmd', text: c }]);
    setCmd('');
    setBusy(true);
    try {
      const res = await api.environmentExec(client, { id: envKey, command: c });
      if (!res.success) {
        setLines((l) => [...l, { kind: 'err', text: res.error ?? '执行失败' }]);
        return;
      }
      const out = res.data?.stdout ?? '';
      const code = res.data?.exitCode;
      setLines((l) => [
        ...l,
        ...(out ? [{ kind: 'out' as const, text: out }] : [{ kind: 'out' as const, text: '（无输出）' }]),
        { kind: 'err', text: `exit=${code ?? 0}` },
      ]);
    } catch (err) {
      setLines((l) => [...l, { kind: 'err', text: err instanceof Error ? err.message : String(err) }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="attach-view show">
      <div className="attach-head">
        <span className="ah-env">◈ {envKey || '未选择环境'}</span>
        <span className="ah-hint">
          已接管 shell（environment/exec 一次性执行）· <kbd>exit</kbd> 或 <kbd>Esc</kbd> 返回会话流
        </span>
        <button className="ah-close" onClick={() => setPage('chat')}>✕</button>
      </div>
      <div className="attach-term">
        {lines.length === 0 && (
          <div className="at-welcome">
            已连接到 {envKey || '…'}
            <br />
            {envKey
              ? '输入命令回车执行（输出与 exit code 落屏）——会话流在后台继续接收'
              : '宿主会话没有环境 shell——回侧栏切换到运行中环境再 /attach'}
          </div>
        )}
        {lines.map((l, i) =>
          l.kind === 'cmd' ? (
            <div className="at-cmd" key={i}>
              <span className="at-prompt">{envKey ? `root@${envKey.split('@')[0]}` : 'host'}:# </span>
              {l.text}
            </div>
          ) : l.kind === 'err' ? (
            <div className="at-exit" key={i}>{l.text}</div>
          ) : (
            <div className="at-out" key={i}>{l.text}</div>
          ),
        )}
        {busy && <div className="at-out"><span className="spinner" /> 执行中…</div>}
      </div>
      <div className="attach-input-line">
        <span className="at-prompt">root@{envKey ? envKey.split('@')[0] : 'host'}:#</span>
        <input
          className="attach-input"
          autoComplete="off"
          spellCheck={false}
          placeholder={busy ? '执行中…' : '输入命令…（exit 返回）'}
          value={cmd}
          disabled={busy}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            void run();
          }}
        />
      </div>
    </div>
  );
}
