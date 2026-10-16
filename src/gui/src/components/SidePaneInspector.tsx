/**
 * SidePane「检查器」页签内容（V4-S2：原崩溃件检查器浮层换壳迁入——overlay
 * backdrop/✕ 壳退役，筛选/列表/复制/诚实边界脚注原样保留）：research/list
 * 的 fuzz 分拣结论桶（crash-triager 落库）按崩溃类指纹过滤查看——triager
 * 判定（outcome 徽章）、结论（summary）、时间与归属 workspace。
 * Esc 语义：页签不占 Esc 链（SidePane ✕/分割条收起）。
 *
 * 事件装配在 model/crash-events.ts（纯函数，已单测）；本组件只读存储
 * （inspectorFilter/crashEvents/crashEventsLoading）与渲染。指纹匹配无命中
 * 时回落全量：指纹来自 campaign crashClasses、bugClass 来自 triager，两条
 * 路径粒度会漂移——空面板比全量面板更容易误导。
 *
 * 入口：CampaignCard 崩溃类 chips → store.openCrashInspector(指纹)——动作
 * 名保留，内部驱动本页签（filter 状态留 store）；「显全部」同动作传 null。
 */

import { useState } from 'react';
import type React from 'react';

import { useGuiStore } from '../store/useGuiStore';
import { crashEventTitle, matchCrashClass } from '../model/crash-events';
import { formatLineUpdated } from '../model/lines';

/** 结论文本面板内截断长度（全文走「复制结论」）。 */
const SUMMARY_LIMIT = 300;

export function SidePaneInspector(): React.JSX.Element {
  const filter = useGuiStore((s) => s.inspectorFilter);
  const events = useGuiStore((s) => s.crashEvents);
  const loading = useGuiStore((s) => s.crashEventsLoading);
  const openCrashInspector = useGuiStore((s) => s.openCrashInspector);
  const refreshCrashEvents = useGuiStore((s) => s.refreshCrashEvents);
  const attachEvidence = useGuiStore((s) => s.attachEvidence);
  const showToast = useGuiStore((s) => s.showToast);
  // 已挂标注（本地 state，不重拉档案）：键 = 事件行 id（旧行 id 缺省用
  // bugClass+createdAt 复合键——同一事件挂过一次就够，防连点重复立实体。
  const [attached, setAttached] = useState<ReadonlySet<string>>(new Set());

  const evKey = (e: { id: number | null; bugClass?: string; createdAt?: string }, i: number) =>
    e.id !== null ? `id:${e.id}` : `${e.bugClass ?? ''}-${e.createdAt ?? ''}-${i}`;

  const markAttached = (key: string) => {
    setAttached((prev) => new Set(prev).add(key));
  };

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
    <div className="sp-inspector">
      <div className="sp-lines-head">
        <span className="sp-lines-title">崩溃件检查器 · fuzz 分拣结论</span>
        <button
          className="ln-icon"
          title="刷新 fuzz 分拣事件（research/list）"
          onClick={() => void refreshCrashEvents()}
        >
          ⟳
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

      <div className="ci-list sp-inspector-list">
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
              {/* 1.9.20 挂证据到档案：一键把 triager 结论落成 V# 证据实体
                  （archive/op evidence——服务端复用 research_archive 执行体，
                  与模型侧 op 语义同口径）。旧行缺 id/双缺内容不可挂。 */}
              <button
                className="btn small"
                disabled={e.id === null || (!e.bugClass && !e.summary) || attached.has(evKey(e, i))}
                title={
                  e.id === null
                    ? '旧行缺行 id，不可挂'
                    : attached.has(evKey(e, i))
                      ? '已挂到研究档案（档案页签可见）'
                      : '挂到研究档案为证据实体 V#（archive/op evidence）'
                }
                onClick={() => {
                  const key = evKey(e, i);
                  void attachEvidence(e.id).then((ok) => ok && markAttached(key));
                }}
              >
                {attached.has(evKey(e, i)) ? '已挂 ✓' : '挂证据'}
              </button>
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
          文件里（:attach 看原文）。挂证据已兑现（上方「挂证据」按钮）。 */}
      <div className="ci-foot">
        寄存器/回溯在环境 crash 文件内——:attach 进环境看
      </div>
    </div>
  );
}
