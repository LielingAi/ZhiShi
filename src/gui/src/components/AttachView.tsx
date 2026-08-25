/**
 * attach 视图——1.3.2「attach 页接真」升级为 1.3.3 双模式：
 *
 *   - 终端模式（默认）：xterm.js 挂 WS `/api/admin/environment/term?env=<envKey>`
 *     （协议见 client/term-client.ts），input/resize 透传、output 写入 terminal，
 *     exit/error 提示后关闭；连不上（无 env/宿主会话/原生模块缺失）提示原因。
 *   - 一次性执行模式：保留 1.3.2 的 POST /api/admin/environment/exec
 *     （stdout + exitCode 落屏）。
 *
 * Esc 返回会话流沿用现有全局 Esc 链（page='attach' → close-page）。宿主会话
 * （未锚定环境）无 shell 可挂——两种模式都提示先切换环境。
 */

import { useEffect, useRef, useState } from 'react';
import type React from 'react';

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

import * as api from '../client/api';
import { TermClient, termUrl } from '../client/term-client';
import { getSettingsClient, useGuiStore } from '../store/useGuiStore';
import { xtermThemeFromVars } from '../model/theme';
import { StateHint } from './StateHint';

type AttachMode = 'term' | 'exec';

interface AttachLine {
  kind: 'cmd' | 'out' | 'err';
  text: string;
}

/** 终端连接状态（本地组件态，不进 store）。 */
type TermStatus = 'idle' | 'connecting' | 'live' | 'closed';

/** 主题色从 CSS 变量取（深浅色一致口径）；1.3.4 起随 store.theme 热更新。 */
function terminalTheme(): { background: string; foreground: string; cursor: string } {
  const css =
    typeof getComputedStyle !== 'undefined' && typeof document !== 'undefined'
      ? getComputedStyle(document.documentElement)
      : null;
  return xtermThemeFromVars(
    (css?.getPropertyValue('--bg-deep') || '').trim(),
    (css?.getPropertyValue('--text') || '').trim(),
  );
}

/** 把当前 CSS 变量主题应用到 xterm 实例（挂载与主题切换共用）。 */
function applyTerminalTheme(term: Terminal): void {
  term.options.theme = terminalTheme();
}

// ---------------------------------------------------------------------------
// 终端模式
// ---------------------------------------------------------------------------

function TermPane({ envKey }: { envKey: string | null }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [status, setStatus] = useState<TermStatus>('idle');
  const [notice, setNotice] = useState<string | null>(null);
  const [exitInfo, setExitInfo] = useState<{ code: number; signal?: string } | null>(null);
  // 1.3.4：订阅主题——切换后重染 xterm（挂载时只取一次的旧取舍已修）。
  const theme = useGuiStore((s) => s.theme);

  useEffect(() => {
    if (!envKey) {
      setStatus('closed');
      setNotice('attach：宿主会话没有环境 shell——先切换到运行中环境再 /attach');
      return;
    }
    const client = getSettingsClient();
    if (!client) {
      setStatus('closed');
      setNotice('未连接 sidecar');
      return;
    }
    const el = containerRef.current;
    if (!el) return;

    const termTheme = terminalTheme();
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12.5,
      fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
      theme: termTheme,
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    try {
      fit.fit();
    } catch {
      // 容器不可见时 fit 可能抛——初始 80×24 兜底。
    }

    setStatus('connecting');
    setNotice(null);
    setExitInfo(null);
    let ws: WebSocket;
    try {
      ws = new WebSocket(termUrl(client.base, envKey));
    } catch (err) {
      setStatus('closed');
      setNotice(`WebSocket 建立失败：${err instanceof Error ? err.message : String(err)}`);
      term.dispose();
      return;
    }

    let closed = false;
    ws.addEventListener('open', () => {
      if (!closed) setStatus('live');
    });
    const termClient = new TermClient({
      ws,
      sink: { write: (data) => term.write(data) },
      onExit: (info) => {
        setExitInfo(info);
        setStatus('closed');
      },
      onError: (message) => {
        setNotice(message);
        setStatus('closed');
        try {
          ws.close();
        } catch {
          // best effort
        }
      },
      onClose: (code) => {
        if (code !== 1000) {
          setStatus('closed');
          if (code === 4001) setNotice('同 env 的新连接已顶替本连接');
        }
      },
    });

    const sub = term.onData((data) => termClient.sendInput(data));

    // resize：ResizeObserver 节流 ~200ms → fit + resize 帧。
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleFit = (): void => {
      if (timer || closed) return;
      timer = setTimeout(() => {
        timer = null;
        if (closed) return;
        try {
          fit.fit();
          termClient.sendResize(term.cols, term.rows);
        } catch {
          // 不可见/已销毁——忽略。
        }
      }, 200);
    };
    const ro = new ResizeObserver(() => scheduleFit());
    ro.observe(el);
    // 首次挂载后补一次（等容器真实尺寸）。
    scheduleFit();

    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ro.disconnect();
      sub.dispose();
      termClient.dispose();
      try {
        ws.close();
      } catch {
        // best effort
      }
      termRef.current = null;
      term.dispose();
    };
  }, [envKey]);

  // 1.3.4：主题切换 → 重染 xterm（options.theme 赋值触发 xterm 重绘）。
  // 声明在主 effect 之后：挂载时终端已建好，本 effect 再刷一次幂等无害；
  // 切换主题时 body.light 已由 store action 同步切好，此处读到即新值。
  useEffect(() => {
    const t = termRef.current;
    if (t) applyTerminalTheme(t);
  }, [theme]);

  return (
    <>
      <div
        ref={containerRef}
        className="attach-xterm"
        style={{ display: status === 'connecting' || status === 'live' || !envKey ? 'block' : 'none' }}
      />
      {status === 'connecting' && <StateHint kind="loading" text="连接终端…" />}
      {exitInfo && (
        <div className="at-exit">
          已退出：exit={exitInfo.code}
          {exitInfo.signal ? `（${exitInfo.signal}）` : ''}——按 <kbd>Esc</kbd> 返回会话流
        </div>
      )}
      {notice && <StateHint kind="error" text={notice} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// 一次性执行模式（1.3.2 保留）
// ---------------------------------------------------------------------------

function ExecPane({ envKey }: { envKey: string | null }): React.JSX.Element {
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
    <>
      <div className="attach-term">
        {lines.length === 0 && (
          <StateHint
            kind="empty"
            text={envKey ? `已连接到 ${envKey}` : '宿主会话没有环境 shell'}
            hint={
              envKey
                ? '输入命令回车执行（输出与 exit code 落屏）——会话流在后台继续接收'
                : '回侧栏切换到运行中环境再 /attach'
            }
          />
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
        {busy && <StateHint kind="loading" text="执行中…" />}
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
    </>
  );
}

// ---------------------------------------------------------------------------
// 视图壳
// ---------------------------------------------------------------------------

export function AttachView(): React.JSX.Element {
  const envKey = useGuiStore((s) => s.currentEnvKey);
  const setPage = useGuiStore((s) => s.setPage);
  const [mode, setMode] = useState<AttachMode>('term');

  return (
    <div className="attach-view show">
      <div className="attach-head">
        <span className="ah-env">◈ {envKey || '未选择环境'}</span>
        <span className="mode-toggle">
          <button
            className={`btn small ${mode === 'term' ? 'mode-on' : ''}`}
            onClick={() => setMode('term')}
            title="交互式 pty 终端（WS /api/admin/environment/term）"
          >
            终端
          </button>
          <button
            className={`btn small ${mode === 'exec' ? 'mode-on' : ''}`}
            onClick={() => setMode('exec')}
            title="一次性命令执行（environment/exec）"
          >
            一次性执行
          </button>
        </span>
        <span className="ah-hint">
          {mode === 'term'
            ? '交互 pty · input/resize 透传 · 重复连接旧连接被顶替'
            : 'environment/exec 一次性执行'}{' '}
          · <kbd>Esc</kbd> 返回会话流
        </span>
        <button className="ah-close" onClick={() => setPage('chat')}>✕</button>
      </div>
      {mode === 'term' ? <TermPane envKey={envKey} /> : <ExecPane envKey={envKey} />}
    </div>
  );
}
