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
 * 1.5.10：「本机已有」接入镜像行（zhishi-env-*，driver 'docker-image'，
 * 带「镜像」徽章）——1.5.13 起无行内按钮，点行即启动为环境
 * （environment/up {recipe, fresh:true}，镜像派生新容器秒开 + 服务端回写登记）；
 * 环境行 ⋯ 菜单加「重新构建…」
 * （recipeId 非空）与「重置容器…」（docker 条目），确认模态文案在
 * model/env-rebuild。
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
import { canRebuildEnv, canResetEnv } from '../model/env-rebuild';

export function EnvSidebar(): React.JSX.Element {
  const envs = useGuiStore((s) => s.envs);
  const running = useGuiStore((s) => s.running);
  const discoveredVm = useGuiStore((s) => s.discoveredVm);
  // 1.5.10：镜像发现条目（zhishi-env-*，本机已有组的镜像行数据源）。
  const discoveredImages = useGuiStore((s) => s.discoveredImages);
  const currentEnvKey = useGuiStore((s) => s.currentEnvKey);
  const switchEnv = useGuiStore((s) => s.switchEnv);
  const startEnv = useGuiStore((s) => s.startEnv);
  const refreshEnvCapability = useGuiStore((s) => s.refreshEnvCapability);
  const requestEnvProvision = useGuiStore((s) => s.requestEnvProvision);
  const registerDiscovered = useGuiStore((s) => s.registerDiscovered);
  const requestEnvRemove = useGuiStore((s) => s.requestEnvRemove);
  const requestEnvDown = useGuiStore((s) => s.requestEnvDown);
  // 1.5.10：镜像行「启动为环境」+ ⋯ 菜单「重新构建/重置容器」。
  const startImageEnv = useGuiStore((s) => s.startImageEnv);
  const requestEnvRebuild = useGuiStore((s) => s.requestEnvRebuild);
  const requestEnvReset = useGuiStore((s) => s.requestEnvReset);
  const openEnvDetail = useGuiStore((s) => s.openEnvDetail);
  const openNewEnv = useGuiStore((s) => s.openNewEnv);
  const setPage = useGuiStore((s) => s.setPage);
  const showToast = useGuiStore((s) => s.showToast);
  // 1.5.9：boot 收起后的重入口。
  const boot = useGuiStore((s) => s.boot);
  const modalKind = useGuiStore((s) => s.modal?.kind);
  const setModal = useGuiStore((s) => s.setModal);
  const bootRunning = boot?.status === 'running' && modalKind !== 'boot';

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
          // 1.5.10（B 拍板）：容器不可认领——本机已有只列镜像 + VM；
          // zhishi 建的容器经 up 回写进登记，不走发现认领（容器缺 /workspace
          // 挂载层，接进来是半成品）。
          ...discoveredVm.map((v) => ({
            id: v.id,
            name: v.name,
            state: v.state,
            driver: v.driver,
            vmx: v.vmx,
            osFamily: v.osFamily,
          })),
          // 1.5.10：镜像行进本机已有组（driver 'docker-image'，带反解的 recipeId）。
          ...discoveredImages.map((d) => ({
            id: d.id,
            name: d.name,
            driver: d.driver,
            image: d.image,
            recipeId: d.recipeId,
          })),
        ],
      ),
    [envs, running, discoveredVm, discoveredImages],
  );

  /** 从 store 最新快照重建侧栏分组（点击重探后重新判定准入）。 */
  const freshGroupsFor = (): ReturnType<typeof groupSidebar> => {
    const s = useGuiStore.getState();
    return groupSidebar(
      s.envs,
      s.running,
      [
        ...s.discoveredVm.map((v) => ({
          id: v.id,
          name: v.name,
          state: v.state,
          driver: v.driver,
          vmx: v.vmx,
          osFamily: v.osFamily,
        })),
        ...s.discoveredImages.map((d) => ({
          id: d.id,
          name: d.name,
          driver: d.driver,
          image: d.image,
          recipeId: d.recipeId,
        })),
      ],
    );
  };

  return (
    <aside className="envbar">
      <div className="eb-title">
        环境
        <button
          className="btn small eb-refresh"
          title="刷新环境列表（重新拉取运行状态）"
          aria-label="刷新环境列表"
          onClick={() => void useGuiStore.getState().refreshSidebar()}
        >
          ⟳
        </button>
      </div>
      {/* 1.5.9：boot 模态收起后的构建进度重入口（构建在服务端继续，
          完成/失败有 toast）——boot running 且模态不在场时显示。 */}
      {bootRunning && (
        <div
          className="eb-item eb-booting"
          title="构建进行中——点击打开进度"
          onClick={() => setModal({ kind: 'boot', recipeId: boot?.recipeId })}
        >
          <span className="spinner" /> 构建中 {boot?.recipeId}
        </div>
      )}
      {/* 1.4.1 修复：环境多时列表滚动、底部入口（新建/设置）恒可见 */}
      <div className="eb-scroll">
        {groups.map((g) => (
        <div className="eb-group" key={g.label}>
          <div className="ebg-label">{g.label}</div>
          {g.items.map((it) => {
            const gate = accessGate(it);
            return (
              <div
                className={`eb-item ${it.key === currentEnvKey ? 'cur' : ''} ${gate.allow || it.registeredAs ? '' : 'gated'}`}
                key={it.key}
                title={it.kind === 'docker-image' ? `${it.detail}——点击启动为环境（派生新容器）` : it.detail}
                onClick={() => {
                  // 1.5.13：镜像行点行即启动为环境（不再要行内按钮）。
                  if (it.kind === 'docker-image') {
                    void startImageEnv(it.key);
                    return;
                  }
                  // 1.3.7 实机修复 A：同族已登记条目点击 = 切入已登记身份（不是再登记）。
                  if (it.registeredAs) {
                    // 1.5.10：目标已停止 → 点行 = 启动（不是切入——切入停止
                    // 环境会静默无反应：planSwitch 同线 unchanged 直返，实机
                    // 「点了没反应」）；目标在跑才切入。
                    const target = groups.flatMap((g) => g.items).find((x) => x.key === it.registeredAs!.key);
                    const targetGate = target ? accessGate(target) : null;
                    if (targetGate && !targetGate.allow && targetGate.reason === 'not-started') {
                      if (targetGate.canStart && target) void startEnv(target.key);
                      else if (target) showToast(gateToast(target, targetGate));
                      return;
                    }
                    void switchEnv(it.registeredAs.key);
                    return;
                  }
                  if (!gate.allow) {
                    // 1.4.0 实机修复：环境刚启动/手动启动时侧栏快照陈旧——
                    // 点击拦截的「未启动」环境先重探一次（ps 现场判定），
                    // 起来就直接进；确实没起再提示先启动。
                    if (gate.reason === 'not-started' && gate.canStart) {
                      void (async () => {
                        await useGuiStore.getState().refreshSidebar();
                        const freshItem = freshGroupsFor()
                          .flatMap((x) => x.items)
                          .find((x) => x.key === it.key);
                        const freshGate = freshItem ? accessGate(freshItem) : gate;
                        if (freshItem && freshGate.allow) {
                          await switchEnv(it.key);
                          return;
                        }
                        showToast(gateToast(it, gate));
                      })();
                      return;
                    }
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
                {/* 1.5.10：镜像行徽章——与容器/VM 行区分（无登记语义，
                    1.5.13 起无按钮，点行即启动为环境）。 */}
                {it.kind === 'docker-image' && (
                  <span className="cap" title={it.detail}>镜像</span>
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
                    {/* 1.5.10：显式重建（recipeId 非空才显示）——镜像重建 +
                        换全新容器，旧现场随删（确认模态文案在 model/env-rebuild）。 */}
                    {canRebuildEnv(it) && (
                      <button
                        className="eb-menu-item"
                        onClick={() => {
                          setMenuFor(null);
                          requestEnvRebuild({ recipe: it.recipeId!, label: it.label });
                        }}
                      >
                        ♻ 重新构建…
                      </button>
                    )}
                    {/* 1.5.10：显式重置（docker 条目）——镜像不动、换干净容器，
                        现场清空。 */}
                    {canResetEnv(it) && (
                      <button
                        className="eb-menu-item"
                        onClick={() => {
                          setMenuFor(null);
                          requestEnvReset({ id: it.key, label: it.label });
                        }}
                      >
                        ⟲ 重置容器…
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
                    {(it.capability?.toolsMissing?.length ?? 0) > 0 && (
                      <button
                        className="eb-menu-item"
                        onClick={() => {
                          setMenuFor(null);
                          requestEnvProvision({
                            id: it.key,
                            label: it.label,
                            missing: it.capability!.toolsMissing!,
                          });
                        }}
                      >
                        🧩 补齐环境（缺 {it.capability!.toolsMissing!.length} 项）
                      </button>
                    )}
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
                {it.group === 'unreg' && !it.registeredAs && it.kind !== 'docker-image' && (
                  <button
                    className="btn small eb-register"
                    title={
                      // 1.5.10：VM 走向导收 address/凭据/配方（容器 1.5.10 起不可认领）
                      //（直登拿不到 address，探测/exec 通道需要它）。
                      discoveredVm.some((v) => v.id === it.key)
                        ? `登记 ${it.label}（打开新建环境向导收 address/凭据/配方）`
                        : `登记 ${it.label}（environment/add，运行中则切入）`
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      // 1.5.10：VM 条目分流到向导 discovered 分支并预勾选。
                      if (discoveredVm.some((v) => v.id === it.key)) {
                        openNewEnv({ discoveredKey: it.key });
                        return;
                      }
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
      </div>
      <div className="eb-foot">
        <button className="btn" onClick={() => openNewEnv()}>＋ 新建环境</button>
        <button className="btn" onClick={() => setPage('settings')}>⚙ 设置</button>
      </div>
    </aside>
  );
}
