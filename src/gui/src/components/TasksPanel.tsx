/**
 * /tasks 面板（1.3.1 ③，overlay 形态）：任务列表（status/结论），
 * 选中行看 transcript——子代理走 GET /api/loop-session/messages，
 * 服务端任务走 task/get。Esc 进 Esc 链（close-tasks 层）。
 *
 * 行装配在 model/tasks.ts::buildTaskRows（纯函数，已单测）；本组件只读
 * 存储（selectTaskRows 选择器）与渲染。transcript 行支持
 * user/assistant/tool 三态展示。
 */

import type React from 'react';

import { selectTaskRows, useGuiStore } from '../store/useGuiStore';
import { campaignActionOf, type CampaignState } from '../model/campaign';
import type { LoopTranscriptLine } from '../client/api';

/** transcript 单行渲染（user / assistant / tool，前 400 字截断）。 */
function TranscriptLine({ line, i }: { line: LoopTranscriptLine; i: number }): React.JSX.Element {
  const role = line.role ?? 'unknown';
  const text =
    typeof line.content === 'string'
      ? line.content
      : line.content !== undefined
        ? JSON.stringify(line.content)
        : '';
  const clipped = text.length > 400 ? `${text.slice(0, 400)}…` : text;
  if (role === 'user') {
    return (
      <div className="tk-line user" key={i}>
        <span className="tk-role">你</span> {clipped}
      </div>
    );
  }
  if (role === 'tool' || role === 'toolResult') {
    return (
      <div className="tk-line tool" key={i}>
        <span className="tk-role">{line.name ?? 'tool'}</span>
        <span className={line.isError ? 'tk-err' : 'tk-ok'}>{line.isError ? ' ✗' : ' ✓'}</span>{' '}
        {clipped}
      </div>
    );
  }
  return (
    <div className="tk-line assistant" key={i}>
      <span className="tk-role">assistant</span> {clipped}
    </div>
  );
}

export function TasksPanel(): React.JSX.Element | null {
  const open = useGuiStore((s) => s.tasksOpen);
  const rows = useGuiStore(selectTaskRows);
  const selected = useGuiStore((s) => s.tasksSelected);
  const selectTaskRow = useGuiStore((s) => s.selectTaskRow);
  const backToList = useGuiStore((s) => s.backToList);
  const closeTasksPanel = useGuiStore((s) => s.closeTasksPanel);
  // 1.6.8 M2：战役卡片行内动作（终止二次确认 / 暂停续命）。
  const requestCampaignStop = useGuiStore((s) => s.requestCampaignStop);
  const resumeCampaign = useGuiStore((s) => s.resumeCampaign);

  if (!open) return null;

  return (
    <div className="overlay-backdrop tasks-backdrop open">
      <div className="overlay-panel tasks-panel">
        <div className="overlay-title">
          子任务与后台进程
          <button className="tp-close" onClick={closeTasksPanel}>
            ✕
          </button>
        </div>
        {selected ? (
          <div className="tp-transcript">
            <div className="tp-head">
              <div className="tp-mid">
                <div className="tp-name">{selected.title}</div>
                <div className="tp-detail">{selected.detail}</div>
              </div>
              <button className="tp-close" onClick={backToList}>
                ← 列表
              </button>
            </div>
            <div className="tp-body">
              {selected.transcript === null && (
                <div className="ov-empty">该行无 transcript（后台进程只有事件快照）</div>
              )}
              {selected.transcript && selected.transcript.length === 0 && (
                <div className="ov-empty">transcript 为空</div>
              )}
              {selected.transcript?.map((l, i) => <TranscriptLine line={l} i={i} key={i} />)}
            </div>
          </div>
        ) : (
          <div className="overlay-list tp-list">
            {rows.length === 0 && (
              <div className="ov-empty">
                暂无子任务/后台进程——agent 用 env_bg / delegate_task 时出现
              </div>
            )}
            {rows.map((r) => (
              <div className={`tp-item ${r.source}`} key={r.key} onClick={() => void selectTaskRow(r.key)}>
                <span className={`tp-status ${r.status === '运行中' || r.source === 'campaign' && r.campaignState === 'running' ? 'running' : ''}`}>{r.status}</span>
                <div className="tp-mid">
                  <div className="tp-name">{r.name}</div>
                  {r.detail && <div className="tp-detail">{r.detail}</div>}
                  {r.conclusion && <div className="tp-conclusion">{r.conclusion}</div>}
                </div>
                {/* 1.6.8 M2：战役行内动作——paused「续命」；盲跑/介入态「终止」
                    （二次确认模态）；终态只读。 */}
                {r.campaignId && campaignActionOf(r.campaignState as CampaignState) === 'resume' && (
                  <button
                    className="btn small"
                    title="campaign/resume——预算耗尽暂停续命（重置墙钟起算）"
                    onClick={(e) => {
                      e.stopPropagation();
                      void resumeCampaign(r.campaignId!);
                    }}
                  >
                    续命
                  </button>
                )}
                {r.campaignId && campaignActionOf(r.campaignState as CampaignState) === 'stop' && (
                  <button
                    className="btn small danger"
                    title="campaign/stop——人终止战役（二次确认）"
                    onClick={(e) => {
                      e.stopPropagation();
                      requestCampaignStop({ id: r.campaignId!, goal: r.name });
                    }}
                  >
                    终止
                  </button>
                )}
                {r.transcriptable && <span className="tp-caret">›</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
