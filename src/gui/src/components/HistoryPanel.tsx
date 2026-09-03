/**
 * 1.3.3 历史面板（本版主线）：会话清单（按 envKey/时间分组 + 搜索）+
 * 只读 wire 回看 + 会话管理（重命名/置顶/归档/删除）+ 载回续跑。
 *
 * 只读回看的约束：wire transcript 经 model/history.ts::buildHistorySession
 * 归约为**组件局部状态**的 SessionState（走 reducer replay 路径，决策块/
 * 工具卡/折叠与活跃流同渲染），绝不写回 store.sessions——不影响正在跑的
 * 活跃会话流。
 *
 * 布局惯例照 SettingsPage（全页接管主区）+ Drawer（头部工具条）。
 */

import { useEffect, useMemo, useState } from 'react';
import type React from 'react';

import { getSettingsClient, selectCurrentSession, useGuiStore } from '../store/useGuiStore';
import * as api from '../client/api';
import type { SessionState, StreamItem } from '../model/blocks';
import {
  archiveEvidence,
  archiveFalsified,
  archiveFindings,
  archiveOpenQuestions,
  archivePendingHypotheses,
  entityRefs,
  ENTITY_STATUS_LABEL,
  FINDING_TYPE_LABEL,
  type ArchiveEntity,
  type ArchiveSnapshot,
} from '../model/archive';
import { buildHistorySession, filterSessionRows, groupSessionRows } from '../model/history';
import type { SessionMetaRow } from '../model/history';
import { TurnView } from './TurnView';
import { RefLine } from './Stream';
import { StateHint } from './StateHint';

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function fmtDate(iso: string): string {
  const t = Date.parse(iso);
  if (!t) return '—';
  const d = new Date(t);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

// ---------------------------------------------------------------------------
// 只读查看器（块渲染复用 TurnView）
// ---------------------------------------------------------------------------

function ViewerItem({ item }: { item: StreamItem }): React.JSX.Element {
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
    case 'ref':
      return <RefLine item={item} />;
  }
}

interface ViewerState {
  status: 'idle' | 'loading' | 'ok' | 'error';
  truncated?: boolean;
  totalMessages?: number;
  session?: SessionState;
  /** 该会话线的研究档案（1.4.6 历史档案查看；无实体 → null 不渲染档案区）。 */
  archive?: ArchiveSnapshot | null;
  error?: string;
}

/** 历史回看的研究档案区（只读——过程记录 + 成果汇总，先成果后过程）。 */
function ArchiveSection({ archive }: { archive: ArchiveSnapshot }): React.JSX.Element {
  const groups: Array<[string, ArchiveEntity[]]> = [
    ['结论', archiveFindings(archive)],
    ['当前假设', archivePendingHypotheses(archive)],
    ['证据', archiveEvidence(archive)],
    ['待答问题', archiveOpenQuestions(archive)],
  ];
  const falsified = archiveFalsified(archive);
  return (
    <div className="hv-archive">
      <div className="hva-head">研究档案（{archive.entities.length} 实体 · 过程记录 + 成果汇总）</div>
      {groups.map(([title, items]) =>
        items.length > 0 ? (
          <div className="hva-group" key={title}>
            <div className="hva-group-title">
              {title} <span className="arc-count">{items.length}</span>
            </div>
            {items.map((e) => (
              <div className="hva-row" key={e.id}>
                <span className="arc-id">{e.id}</span>
                {e.findingType && (
                  <span className="arc-kind">{FINDING_TYPE_LABEL[e.findingType] ?? e.findingType}</span>
                )}
                <span className="arc-text">{e.text}</span>
                {ENTITY_STATUS_LABEL[e.status] && (
                  <span className={`arc-chip${['falsified', 'overturned', 'corrected', 'doubtful'].includes(e.status) ? ' arc-chip-bad' : ''}`}>
                    {ENTITY_STATUS_LABEL[e.status]}
                  </span>
                )}
                {entityRefs(e).map((r) => (
                  <span className="arc-ref" key={r}>{r}</span>
                ))}
                {e.anchorLabel && <div className="hva-anchor">{e.anchorLabel}</div>}
              </div>
            ))}
          </div>
        ) : null,
      )}
      {falsified.length > 0 && (
        <div className="hva-group">
          <div className="hva-group-title">
            证伪与纠正 <span className="arc-count">{falsified.length}</span>
          </div>
          {falsified.map((row) =>
            row.correction ? (
              <div className="hva-row" key={row.correction.id}>
                <span className="arc-id">{row.correction.id}</span>
                <span className="arc-kind">{row.correction.by === 'human' ? '人纠正' : '模型自证伪'}</span>
                <span className="arc-text">
                  {row.entity ? `${row.entity.id} ${row.entity.text}` : row.correction.targetId}
                </span>
                <div className="hva-anchor">{row.correction.reason}</div>
              </div>
            ) : row.entity ? (
              <div className="hva-row" key={row.entity.id}>
                <span className="arc-id">{row.entity.id}</span>
                <span className="arc-text">{row.entity.text}</span>
                <span className="arc-chip arc-chip-bad">{ENTITY_STATUS_LABEL[row.entity.status]}</span>
              </div>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 面板
// ---------------------------------------------------------------------------

export function HistoryPanel(): React.JSX.Element {
  const historySessions = useGuiStore((s) => s.historySessions);
  const historyError = useGuiStore((s) => s.historyError);
  const openHistoryPanel = useGuiStore((s) => s.openHistoryPanel);
  const renameSession = useGuiStore((s) => s.renameSession);
  const toggleSessionPinned = useGuiStore((s) => s.toggleSessionPinned);
  const toggleSessionArchived = useGuiStore((s) => s.toggleSessionArchived);
  const deleteSessionRow = useGuiStore((s) => s.deleteSessionRow);
  const resumeSession = useGuiStore((s) => s.resumeSession);
  const setPage = useGuiStore((s) => s.setPage);
  // 1.3.4：载回续跑 busy 前置闸（与 esc 链同口径 phase === 'running'）——
  // 按钮禁用 + store 内 toast 双保险。
  const busy = useGuiStore((s) => selectCurrentSession(s).phase === 'running');

  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewer, setViewer] = useState<ViewerState>({ status: 'idle' });
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(true);

  // 打开即载清单（store 幂等：已载过不重复拉）。
  useEffect(() => {
    void openHistoryPanel();
  }, [openHistoryPanel]);

  // 点行 → 只读回看：拉 wire transcript 归约为局部 SessionState。
  useEffect(() => {
    if (!selectedId) return;
    const row = historySessions?.find((r) => r.id === selectedId);
    if (!row) {
      setViewer({ status: 'error', error: '会话不存在（可能刚被删除）' });
      return;
    }
    if (!row.loopSessionId) {
      setViewer({
        status: 'error',
        error: '该会话没有 loop-session 绑定（旧会话 / 从未落盘），无法 wire 回看',
      });
      return;
    }
    const c = getSettingsClient();
    if (!c) {
      setViewer({ status: 'error', error: '未连接 sidecar' });
      return;
    }
    const loopId = row.loopSessionId; // 闭包内稳定引用（TS 收窄不进闭包）
    let cancelled = false;
    setViewer({ status: 'loading' });
    void (async () => {
      try {
        const res = await api.fetchSessionWire(c, loopId);
        if (cancelled) return;
        if (!res.success) {
          setViewer({ status: 'error', error: res.error ?? 'wire transcript 读取失败' });
          return;
        }
        // 1.4.6 历史研究档案：随 wire 一并加载（独立失败/无实体 → null，不影响回放）。
        let archive: ArchiveSnapshot | null = null;
        try {
          const ar = await api.fetchArchiveList(c, { sessionId: loopId });
          if (ar.ok && ar.archive && ar.archive.entities.length > 0) archive = ar.archive;
        } catch {
          /* 档案缺失不影响回放 */
        }
        if (cancelled) return;
        setViewer({
          status: 'ok',
          session: buildHistorySession(res.messages ?? []),
          truncated: res.truncated === true,
          totalMessages: res.totalMessages,
          archive,
        });
      } catch (err) {
        if (cancelled) return;
        setViewer({
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId, historySessions]);

  const groups = useMemo(
    () => groupSessionRows(filterSessionRows(historySessions ?? [], search)),
    [historySessions, search],
  );
  const selectedRow = selectedId ? historySessions?.find((r) => r.id === selectedId) ?? null : null;

  const commitRename = (row: SessionMetaRow) => {
    const t = renameDraft.trim();
    setRenamingId(null);
    if (t && t !== row.title) void renameSession(row.id, t);
  };

  const onDelete = (row: SessionMetaRow) => {
    if (confirmDeleteId !== row.id) {
      setConfirmDeleteId(row.id); // 第一次点击进确认态
      return;
    }
    setConfirmDeleteId(null);
    if (selectedId === row.id) {
      setSelectedId(null);
      setViewer({ status: 'idle' });
    }
    void deleteSessionRow(row.id);
  };

  const resume = (row: SessionMetaRow) => {
    void resumeSession(row.id);
  };

  return (
    <div className="history-page show">
      <div className="history-head">
        <span className="hh-title">历史会话</span>
        <input
          className="hh-search"
          placeholder="搜索标题 / 内容预览…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button className="btn small" onClick={() => void openHistoryPanel(true)} title="重新拉取会话清单">
          ⟳ 刷新
        </button>
        <button className="history-close" onClick={() => setPage('chat')} title="Esc 返回会话流">
          ✕
        </button>
      </div>
      <div className="history-main">
        <div className="history-list">
          {historySessions === null ? (
            historyError ? (
              <StateHint kind="error" text="会话清单载入失败" hint={`${historyError} · 点「⟳ 刷新」重试`} />
            ) : (
              <StateHint kind="loading" text="会话清单加载中…" />
            )
          ) : groups.length === 0 ? (
            <StateHint
              kind="empty"
              text={search ? '无匹配会话' : '暂无会话'}
              hint={search ? undefined : '新对话落盘后这里会出现记录'}
            />
          ) : (
            groups.map((g) => (
              <div className="history-group" key={g.key}>
                <div
                  className={`history-group-label ${g.archived ? 'toggle' : ''}`}
                  onClick={() => g.archived && setArchivedOpen(!archivedOpen)}
                >
                  <span>{g.archived ? (archivedOpen ? '⏷' : '⏵') : ''} {g.label}</span>
                  <span className="count">{g.rows.length}</span>
                </div>
                {(!g.archived || archivedOpen) &&
                  g.rows.map((r) => (
                    <SessionRow
                      key={r.id}
                      row={r}
                      selected={r.id === selectedId}
                      renaming={renamingId === r.id}
                      renameDraft={renameDraft}
                      confirming={confirmDeleteId === r.id}
                      onSelect={() => {
                        setSelectedId(r.id);
                        setConfirmDeleteId(null);
                      }}
                      onStartRename={() => {
                        setRenamingId(r.id);
                        setRenameDraft(r.title);
                        setConfirmDeleteId(null);
                      }}
                      onRenameDraft={setRenameDraft}
                      onCommitRename={() => commitRename(r)}
                      onCancelRename={() => setRenamingId(null)}
                      onTogglePinned={() => void toggleSessionPinned(r.id)}
                      onToggleArchived={() => void toggleSessionArchived(r.id)}
                      onDelete={() => onDelete(r)}
                      onResume={() => resume(r)}
                    />
                  ))}
              </div>
            ))
          )}
        </div>
        <div className="history-viewer">
          {!selectedRow && (
            <StateHint kind="empty" center text="← 选一条会话查看只读回放" hint="决策块 / 工具卡照常渲染" />
          )}
          {selectedRow && (
            <>
              <div className="hv-head">
                <div className="hv-mid">
                  <div className="hv-title">{selectedRow.title}</div>
                  <div className="hv-sub">
                    {fmtDate(selectedRow.lastActiveAt)} · {selectedRow.messageCount} 条消息
                    {selectedRow.envKey ? ` · ${selectedRow.envKey}` : ' · 宿主'}
                  </div>
                </div>
                {/* 1.4.7：auto-run 合成行藏「载回续跑」——run 无会话元绑定，点了报错 */}
                {!selectedRow.id.startsWith('auto-run:') && (
                  <button
                    className="btn primary small"
                    disabled={busy}
                    title={
                      busy
                        ? '当前 turn 运行中——Esc 中断后再载回（避免与活跃会话流冲突）'
                        : 'POST /sessions/switch 载回续跑（关闭面板回到活跃会话视图）'
                    }
                    onClick={() => resume(selectedRow)}
                  >
                    ↺ 载回续跑
                  </button>
                )}
              </div>
              {(viewer.status === 'loading' || viewer.status === 'idle') && (
                <StateHint kind="loading" center text="读取 wire transcript…" />
              )}
              {viewer.status === 'error' && (
                <StateHint kind="error" center text={viewer.error ?? 'wire transcript 读取失败'} />
              )}
              {viewer.status === 'ok' && viewer.session && (
                <>
                  {viewer.archive && <ArchiveSection archive={viewer.archive} />}
                  {viewer.truncated && (
                    <div className="hv-truncated">
                      ⚠ 消息超护栏（共 {viewer.totalMessages ?? '?'} 条），仅回放前 2000 条（时间序保留）
                    </div>
                  )}
                  <div className="hv-body">
                    {viewer.session.items.length === 0 && (
                      <StateHint kind="empty" text="该会话 wire 为空" />
                    )}
                    {viewer.session.items.map((item) => (
                      <ViewerItem item={item} key={item.id} />
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 会话行（重命名内联 / 置顶 / 归档 / 删除二次确认 / 载回）
// ---------------------------------------------------------------------------

interface SessionRowProps {
  row: SessionMetaRow;
  selected: boolean;
  renaming: boolean;
  renameDraft: string;
  confirming: boolean;
  onSelect(): void;
  onStartRename(): void;
  onRenameDraft(v: string): void;
  onCommitRename(): void;
  onCancelRename(): void;
  onTogglePinned(): void;
  onToggleArchived(): void;
  onDelete(): void;
  onResume(): void;
}

function SessionRow(p: SessionRowProps): React.JSX.Element {
  const r = p.row;
  return (
    <div
      className={`history-row ${p.selected ? 'sel' : ''}`}
      onClick={p.onSelect}
      title={`${r.lastMessagePreview ?? ''}${r.loopSessionId ? '' : '\n（无 loop 绑定，不可 wire 回看）'}`}
    >
      {r.pinned === true && <span className="hr-pin" title="已置顶">📌</span>}
      <div className="hr-mid">
        {p.renaming ? (
          <input
            className="hr-rename"
            autoFocus
            value={p.renameDraft}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => p.onRenameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                p.onCommitRename();
              } else if (e.key === 'Escape') {
                // 阻止冒泡：全局 Esc 链会把 page='history' 关掉，这里只取消重命名。
                e.stopPropagation();
                p.onCancelRename();
              }
            }}
            onBlur={p.onCommitRename}
          />
        ) : (
          <>
            <div className="hr-title">{r.title || 'New Chat'}</div>
            <div className="hr-preview">
              {r.lastMessagePreview ?? '（无预览）'}
            </div>
          </>
        )}
      </div>
      <span className="hr-meta">
        {fmtDate(r.lastActiveAt)} · {r.messageCount}
      </span>
      <span className="hr-actions" onClick={(e) => e.stopPropagation()}>
        <button className="hr-act" title="重命名（PATCH title）" onClick={p.onStartRename}>✎</button>
        <button
          className={`hr-act ${r.pinned ? 'on' : ''}`}
          title={r.pinned ? '取消置顶' : '置顶（PATCH pinned）'}
          onClick={p.onTogglePinned}
        >
          ▲
        </button>
        <button
          className={`hr-act ${r.archived ? 'on' : ''}`}
          title={r.archived ? '取消归档' : '归档（PATCH archived，默认藏到已归档组）'}
          onClick={p.onToggleArchived}
        >
          ⬚
        </button>
        <button
          className={`hr-act danger ${p.confirming ? 'confirm' : ''}`}
          title={p.confirming ? '再点一次确认删除（含 transcript，不可恢复）' : '删除会话（DELETE，含 transcript）'}
          onClick={p.onDelete}
        >
          {p.confirming ? '确认?' : '✕'}
        </button>
      </span>
    </div>
  );
}
