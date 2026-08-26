/**
 * 环境侧栏（1.3.1 ①）：三组（运行中/已停止/本机已有）+ 准入闸 +
 * 「已停止」行的启动按钮（environment/up）+ 已登记行的「删除」图标按钮
 * （environment/rm，1.3.7 补口；运行中点击提示先停止，确认文案/强度
 * 在 model/env-remove）+ 「运行中」行的停止按钮（environment/down，
 * 1.3.8 ①，有损操作确认模态文案在 model/env-down）+ 底部「＋新建环境」「⚙ 设置」。
 *
 * 1.3.7 实机修复 A：「本机已有」行带 registeredAs 徽章（同族命中已登记
 * 条目，见 model/envs.matchRegisteredEnv）——不出「登记」按钮，点击
 * 直接切入已登记身份，防同一 VM/容器重复登记。
 *
 * 准入判定在 model/envs.ts（分组）+ model/access-gate.ts（点击拦截/启动
 * 按钮可见性，纯函数已单测）；本组件只接线到 store。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';

import { useGuiStore } from '../store/useGuiStore';
import { capabilityBadgeText, capabilityTooltip, groupSidebar } from '../model/envs';
import { accessGate, gateToast } from '../model/access-gate';
import { canStopEnv } from '../model/env-down';

export function EnvSidebar(): React.JSX.Element {
  const envs = useGuiStore((s) => s.envs);
  const running = useGuiStore((s) => s.running);
  const discoveredDocker = useGuiStore((s) => s.discoveredDocker);
  const discoveredVm = useGuiStore((s) => s.discoveredVm);
  const currentEnvKey = useGuiStore((s) => s.currentEnvKey);
  const switchEnv = useGuiStore((s) => s.switchEnv);
  const startEnv = useGuiStore((s) => s.startEnv);
  const refreshEnvCapability = useGuiStore((s) => s.refreshEnvCapability);
  const registerDiscovered = useGuiStore((s) => s.registerDiscovered);
  const requestEnvRemove = useGuiStore((s) => s.requestEnvRemove);
  const requestEnvDown = useGuiStore((s) => s.requestEnvDown);
  const openEnvDetail = useGuiStore((s) => s.openEnvDetail);
  const openNewEnv = useGuiStore((s) => s.openNewEnv);
  const setPage = useGuiStore((s) => s.setPage);
  const showToast = useGuiStore((s) => s.showToast);

  // 1.3.8 视觉：行操作收进「⋯」下拉菜单（单入口，菜单项带文字标签）。
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuFor) return;
    const onDown = (ev: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(ev.target as Node)) {
        setMenuFor(null);
      }
    };
    const onEsc = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setMenuFor(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [menuFor]);

  const groups = useMemo(
    () =>
      groupSidebar(
        envs,
        running,
        [
          ...discoveredDocker.map((d) => ({ id: d.id, name: d.name, state: d.status, driver: 'docker' })),
          ...discoveredVm.map((v) => ({
            id: v.id,
            name: v.name,
            state: v.state,
            driver: v.driver,
            vmx: v.vmx,
            osFamily: v.osFamily,
          })),
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
                className={`eb-item ${it.key === currentEnvKey ? 'cur' : ''} ${gate.allow || it.registeredAs ? '' : 'gated'}`}
                key={it.key}
                title={it.detail}
                onClick={() => {
                  // 1.3.7 实机修复 A：同族已登记条目点击 = 切入已登记身份（不是再登记）。
                  if (it.registeredAs) {
                    void switchEnv(it.registeredAs.key);
                    return;
                  }
                  if (!gate.allow) {
                    showToast(gateToast(it, gate));
                    return;
                  }
                  void switchEnv(it.key);
                }}
              >
                <span className={`st ${it.group}`} />
                <span className="nm">{it.label}</span>
                {it.capability && (
                  <span className="cap" title={capabilityTooltip(it.capability)}>
                    {capabilityBadgeText(it.capability)}
                  </span>
                )}
                {it.registeredAs && (
                  <span className="cap reg" title={`该本机条目已登记为 ${it.registeredAs.label}（点击切入）`}>
                    已登记为 {it.registeredAs.label}
                  </span>
                )}
                {it.group === 'run' && <span className="snap">◆</span>}
                {it.warn && <span className="warn">⚠</span>}
                {/* 1.3.8 视觉：行操作收进「⋯」下拉菜单（单入口，文字标签，不依赖悬停提示） */}
                {it.group !== 'unreg' && (
                  <span className="eb-actions">
                    <button
                      className="btn small eb-start"
                      title={`操作（${it.label}）`}
                      aria-label={`操作 ${it.label}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuFor(menuFor === it.key ? null : it.key);
                      }}
                    >
                      ⋯
                    </button>
                  </span>
                )}
                {it.group !== 'unreg' && menuFor === it.key && (
                  <div className="eb-menu" ref={menuRef} onClick={(e) => e.stopPropagation()}>
                    {!gate.allow && gate.reason === 'not-started' && gate.canStart && (
                      <button
                        className="eb-menu-item"
                        onClick={() => {
                          setMenuFor(null);
                          void startEnv(it.key);
                        }}
                      >
                        ▶ 启动（environment/up）
                      </button>
                    )}
                    {it.group === 'run' && canStopEnv(it.kind) && (
                      <button
                        className="eb-menu-item"
                        onClick={() => {
                          setMenuFor(null);
                          requestEnvDown({ id: it.key, label: it.label, kind: it.kind });
                        }}
                      >
                        ⏹ 停止（有损，需确认）
                      </button>
                    )}
                    <button
                      className="eb-menu-item"
                      onClick={() => {
                        setMenuFor(null);
                        void refreshEnvCapability(it.key);
                      }}
                    >
                      ⟳ 重推能力集合
                    </button>
                    <button
                      className="eb-menu-item"
                      onClick={() => {
                        setMenuFor(null);
                        openEnvDetail(it.key);
                      }}
                    >
                      ℹ 环境详情
                    </button>
                    <button
                      className="eb-menu-item danger"
                      onClick={() => {
                        setMenuFor(null);
                        requestEnvRemove({
                          id: it.key,
                          label: it.label,
                          kind: it.kind,
                          vmx: it.vmx,
                          running: it.group === 'run',
                        });
                      }}
                    >
                      🗑 删除环境…
                    </button>
                  </div>
                )}
                {it.group === 'unreg' && !it.registeredAs && (
                  <button
                    className="btn small eb-start"
                    title={`登记 ${it.label}（environment/add，运行中则切入）`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void registerDiscovered(it.key);
                    }}
                  >
                    登记
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
        <button className="btn" onClick={openNewEnv}>＋ 新建环境</button>
        <button className="btn" onClick={() => setPage('settings')}>⚙ 设置</button>
      </div>
    </aside>
  );
}
