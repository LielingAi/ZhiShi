/**
 * 崩溃件检查器（第四批 v4 落地：crash 对象双击 → 检查器）：research/list
 * 的 fuzz 分拣结论桶（crash-triager 落库）按崩溃类指纹过滤查看——
 * triager 判定（outcome 徽章）、结论（summary）、时间与归属 workspace。
 * overlay 形态仿 LinesPanel；Esc 进 Esc 链（close-inspector 层，lines 之
 * 后、queue 之前——与 lines 同族）。
 *
 * 事件装配在 model/crash-events.ts（纯函数，已单测）；本组件只读存储
 * （inspectorOpen/inspectorFilter/crashEvents/crashEventsLoading）与渲染。
 * 指纹匹配无命中时回落全量：指纹来自 campaign crashClasses、bugClass 来
 * 自 triager，两条路径粒度会漂移——空面板比全量面板更容易误导。
 */

import type React from 'react';

import { useGuiStore } from '../store/useGuiStore';
import { crashEventTitle, matchCrashClass } from '../model/crash-events';
import { formatLineUpdated } from '../model/lines';

/** 结论文本面板内截断长度（全文走「复制结论」）。 */
const SUMMARY_LIMIT = 300;

export function CrashInspector(): React.JSX.Element | null {
  const open = useGuiStore((s) => s.inspectorOpen);
  const filter = useGuiStore((s) => s.inspectorFilter);
  const events = useGuiStore((s) => s.crashEvents);
  const loading = useGuiStore((s) => s.crashEventsLoading);
  const closeCrashInspector = useGuiStore((s) => s.closeCrashInspector);
  const openCrashInspector = useGuiStore((s) => s.openCrashInspector);
  const refreshCrashEvents = useGuiStore((s) => s.refreshCrashEvents);
  const showToast = useGuiStore((s) => s.showToast);

  if (!open) return null;

  const matched = filter ? matchCrashClass(events, filter) : events;
  // 无命中回落全量（见文件头注释）；filter 条仍报真实匹配数,全量由
  // 「显全部」显式收回。
  const shown = filter && matched.length === 0 ? events : matched;

  const copy = (text: string, what: string) => {
    void navigator.clipboard
      .writeText(text)
      .then(() => showToast(`✓ ${what}已复制`))
      .catch(() => showToast('复制失败'));
  };

  return (
    <div className="overlay-backdrop ci-backdrop open">
      <div className="overlay-panel ci-panel">
        <div className="overlay-title ci-title">
          崩溃件检查器 · fuzz 分拣结论
          <button
            className="ln-icon"
            title="刷新 fuzz 分拣事件（research/list）"
            onClick={() => void refreshCrashEvents()}
          >
            ⟳
          </button>
          <button className="tp-close" onClick={closeCrashInspector}>
            ✕
          </button>
        </div>

        {filter && (
          <div className="ci-filter">
            指纹 <span className="ci-fp-text">{filter}</span> · 匹配 {matched.length} 条
            <button
              className="btn small"
              title="清除指纹过滤,显全部 fuzz 分拣事件"
              onClick={() => openCrashInspector(null)}
            >
              显全部
            </button>
          </div>
        )}

        <div className="overlay-list ci-list">
          {shown.length === 0 && (
            <div className="ov-empty">
              {loading ? '拉取…' : '还没有 fuzz 分拣事件——战役命中崩溃后 crash-triager 会落库'}
            </div>
          )}
          {shown.map((e, i) => (
            <div className="ci-item" key={e.id ?? `${e.bugClass ?? ''}-${e.createdAt ?? ''}-${i}`}>
              <div className="ci-row">
                <span className="ci-fp">{crashEventTitle(e)}</span>
                {e.outcome && <span className="ci-badge">{e.outcome}</span>}
                <span className="ci-ts">{formatLineUpdated(e.createdAt) || '—'}</span>
              </div>
              {e.summary && (
                <div className="ci-summary">
                  {e.summary.length > SUMMARY_LIMIT ? `${e.summary.slice(0, SUMMARY_LIMIT)}…` : e.summary}
                </div>
              )}
              {e.workspace && <div className="ci-ws">{e.workspace}</div>}
              <div className="ci-ops">
                <button
                  className="btn small"
                  disabled={!e.bugClass}
                  onClick={() => e.bugClass && copy(e.bugClass, '指纹')}
                >
                  复制指纹
                </button>
                <button
                  className="btn small"
                  disabled={!e.summary}
                  onClick={() => e.summary && copy(e.summary, '结论')}
                >
                  复制结论
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* 诚实边界：面板只到 triager 结论层——寄存器/回溯在环境 crash
            文件里（:attach 看原文）；结论挂档案（archive/op）是后续批次。 */}
        <div className="ci-foot">
          寄存器/回溯在环境 crash 文件内——:attach 进环境看；挂证据到档案（archive/op）待后续批次
        </div>
      </div>
    </div>
  );
}
