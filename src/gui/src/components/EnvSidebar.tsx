/**
 * 环境侧栏：三组（运行中/已停止/本机已有）+ 底部「＋新建环境」「⚙ 设置」。
 * 分组逻辑在 model/envs.ts（纯函数，已单测）；这里选原始数组（稳定引用）
 * 后用 useMemo 组装，避免 selector 每次返回新引用触发高频重渲。
 */

import { useMemo } from 'react';

import { useGuiStore } from '../store/useGuiStore';
import { groupSidebar, isSwitchable } from '../model/envs';

export function EnvSidebar(): React.JSX.Element {
  const envs = useGuiStore((s) => s.envs);
  const running = useGuiStore((s) => s.running);
  const discoveredDocker = useGuiStore((s) => s.discoveredDocker);
  const discoveredVm = useGuiStore((s) => s.discoveredVm);
  const currentEnvKey = useGuiStore((s) => s.currentEnvKey);
  const switchEnv = useGuiStore((s) => s.switchEnv);
  const openNewEnv = useGuiStore((s) => s.openNewEnv);
  const setPage = useGuiStore((s) => s.setPage);
  const showToast = useGuiStore((s) => s.showToast);

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
          {g.items.map((it) => (
            <div
              className={`eb-item ${it.key === currentEnvKey ? 'cur' : ''}`}
              key={it.key}
              title={it.detail}
              onClick={() => {
                if (!isSwitchable(it)) {
                  showToast(`${it.label} 未登记——用「＋新建环境」接入（MVP 提示）`);
                  return;
                }
                void switchEnv(it.key);
              }}
            >
              <span className={`st ${it.group}`} />
              <span className="nm">{it.label}</span>
              {it.group === 'run' && <span className="snap">◆</span>}
              {it.warn && <span className="warn">⚠</span>}
            </div>
          ))}
        </div>
      ))}
      {groups.length === 0 && (
        <div className="eb-empty">连接 sidecar 后加载环境列表…</div>
      )}
      <div className="eb-foot">
        <button className="btn" onClick={openNewEnv}>＋ 新建环境</button>
        <button className="btn" onClick={() => setPage('settings')}>⚙ 设置</button>
      </div>
    </aside>
  );
}
