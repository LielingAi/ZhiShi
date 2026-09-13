/**
 * 1.7.3 — 研究记录页筛选（design: 1.7.3-gui.md §4）。
 * 纯函数、组件本地状态——服务端 research/list 语义不动。
 */

export interface ResearchEventFilterState {
  taskKind?: string;
  outcome?: string;
  query?: string;
}

export interface ResearchEventLike {
  id?: number;
  taskKind?: string;
  outcome?: string;
  summary?: string;
  bugClass?: string;
  /** 筛选不消费,渲染保留。 */
  createdAt?: string;
}

export function filterResearchEvents(
  events: ResearchEventLike[],
  filter: ResearchEventFilterState,
): ResearchEventLike[] {
  const q = filter.query?.trim().toLowerCase() ?? '';
  return events.filter((e) => {
    if (filter.taskKind && e.taskKind !== filter.taskKind) return false;
    if (filter.outcome && e.outcome !== filter.outcome) return false;
    if (q) {
      const hay = `${e.summary ?? ''} ${e.bugClass ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}
