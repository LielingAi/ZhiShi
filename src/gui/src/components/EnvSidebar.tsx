/**
 * 环境侧栏（1.3.1 ①）：三组（运行中/已停止/本机已有）+ 准入闸 +
 * 「已停止」行的启动按钮（environment/up）+ 底部「＋新建环境」「⚙ 设置」。
 *
 * 准入判定在 model/envs.ts（分组）+ model/access-gate.ts（点击拦截/启动
 * 按钮可见性，纯函数已单测）；本组件只接线到 store。
 */

import { useMemo } from 'react';

import { useGuiStore } from '../store/useGuiStore';
import { groupSidebar } from '../model/envs';
import { accessGate, gateToast } from '../model/access-gate';

export function EnvSidebar(): React.JSX.Element {
  const envs = useGuiStore((s) => s.envs);
  const running = useGuiStore((s) => s.running);
  const discoveredDocker = useGuiStore((s) => s.discoveredDocker);
  const discoveredVm = useGuiStore((s) => s.discoveredVm);
  const currentEnvKey = useGuiStore((s) => s.currentEnvKey);
  const switchEnv = useGuiStore((s) => s.switchEnv);
  const startEnv = useGuiStore((s) => s.startEnv);
  const openNewEnv = useGuiStore((s) => s.openNewEnv);
  const setPage = useGuiStore((s) => s.setPage);
  const showToast = useGuiStore((s) => s.showToast);
  const openHistoryPanel = useGuiStore((s) => s.openHistoryPanel);

  const groups = useMemo(
    () =>
      groupSidebar(
        envs,
        running,
        [
          ...discoveredDocker.map((d) => ({ id: d.id, name: d.name, state: d.status, driver: 'docker' })),
          ...discoveredVm.map((v) => ({ id: v.id, name: v.name, state: v.state, driver: v.driver })),
        ],
      ),
    [envs, running, discoveredDocker, discoveredVm],
  );

  return (
    <aside className="envbar">
      <div className="eb-title">环境</div>
      {groups.map((g) => (
        <div className="eb-group" key={g.label}>
          <div className="ebg-label">{g.label}</div>
          {g.items.map((it) => {
            const gate = accessGate(it);
            return (
              <div
                className={`eb-item ${it.key === currentEnvKey ? 'cur' : ''} ${gate.allow ? '' : 'gated'}`}
                key={it.key}
                title={it.detail}
                onClick={() => {
                  if (!gate.allow) {
                    showToast(gateToast(it, gate));
                    return;
                  }
                  void switchEnv(it.key);
                }}
              >
                <span className={`st ${it.group}`} />
                <span className="nm">{it.label}</span>
                {it.group === 'run' && <span className="snap">◆</span>}
                {it.warn && <span className="warn">⚠</span>}
                {!gate.allow && gate.reason === 'not-started' && gate.canStart && (
                  <button
                    className="btn small eb-start"
                    title={`启动 ${it.label}（environment/up）`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void startEnv(it.key);
                    }}
                  >
                    启动
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ))}
      {groups.length === 0 && (
        <div className="eb-empty">连接 sidecar 后加载环境列表…</div>
      )}
      <div className="eb-foot">
        <button className="btn" onClick={() => void openHistoryPanel()}>▤ 历史会话</button>
        <button className="btn" onClick={openNewEnv}>＋ 新建环境</button>
        <button className="btn" onClick={() => setPage('settings')}>⚙ 设置</button>
      </div>
    </aside>
  );
}
