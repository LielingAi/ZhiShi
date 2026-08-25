/**
 * 模态（新建环境向导 / SSH 接入 / VM 认领 / 构建进度）。
 * 向导 = 配方列表（/api/admin/environment/recipes，真实数据）+ SSH 接入
 * （/api/admin/environment/add，真实落盘）；VM 认领与构建进度为 UI 完整的
 * mock（MVP 范围：真实接口留待后续迭代，见交付报告）。
 */

import { useEffect, useRef, useState } from 'react';
import type React from 'react';

import { useGuiStore } from '../store/useGuiStore';
import type { Recipe } from '../client/api';

const BOOT_STEPS = '①②③④⑤⑥⑦⑧';

function fallbackRecipe(id: string | undefined): Recipe {
  return { id: id ?? 'env', name: id ?? 'env', tools: [] };
}

// ── 构建进度（mock 阶段动画） ─────────────────────────────────────────

function BootModalInner({ recipeId }: { recipeId: string }): React.JSX.Element {
  const showToast = useGuiStore((s) => s.showToast);
  const closeModal = useGuiStore((s) => s.closeModal);
  const refreshSidebar = useGuiStore((s) => s.refreshSidebar);
  const recipe = useGuiStore((s) => s.recipes.find((r) => r.id === recipeId)) ?? fallbackRecipe(recipeId);

  const stages = recipe.base === 'vm'
    ? ['快照 revert · zhishi-clean', '启动 VM（vmrun start）', '等待 SSH 就绪', '取 guest 地址', '连接握手', '会话锚定']
    : ['拉取镜像', '初始化脚本', '工具自检', '网络就绪', '连接握手', '会话锚定'];
  const [step, setStep] = useState(0);
  const doneRef = useRef(false);

  useEffect(() => {
    const timer = setInterval(() => setStep((s) => s + 1), 650);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (step >= stages.length && !doneRef.current) {
      doneRef.current = true;
      showToast(`环境 ${recipe.id} 构建完成（MVP mock——未真实 up）`);
      closeModal();
      void refreshSidebar();
    }
  }, [step, stages.length, showToast, closeModal, refreshSidebar, recipe.id]);

  return (
    <div className="modal-backdrop open">
      <div className="modal">
        <div className="m-head">
          <span className="m-title">
            构建环境 <b className="m-env-name">{recipe.id}</b>
          </span>
          <span className="m-sub">{recipe.base} · 新建环境 · 构建全自动（MVP mock）</span>
          <button className="m-close" onClick={closeModal}>✕</button>
        </div>
        <div className="m-body">
          {stages.map((name, i) => (
            <div className={`bs ${i < step ? 'done' : i === step ? 'cur' : ''}`} key={name}>
              <span className="bs-idx">{BOOT_STEPS[i] ?? i + 1}</span>
              <span className="bs-name">{name}</span>
              <span className="bs-state">
                {i < step ? '完成' : i === step ? <span className="spinner" /> : '待 …'}
              </span>
            </div>
          ))}
          <div className="m-hint">Esc 取消 · 失败即停，绝不半进</div>
        </div>
      </div>
    </div>
  );
}

// ── SSH 接入（真实 environment/add） ───────────────────────────────────

function SshModal(): React.JSX.Element {
  const closeModal = useGuiStore((s) => s.closeModal);
  const submitSsh = useGuiStore((s) => s.submitSsh);
  const [host, setHost] = useState('');
  const [user, setUser] = useState('');
  const [keyPath, setKeyPath] = useState('');
  const [err, setErr] = useState('');

  return (
    <div className="modal-backdrop open">
      <div className="modal">
        <div className="m-head">
          <span className="m-title">通过 SSH 连接主机</span>
          <span className="m-sub">手动接入 · 三步表单</span>
          <button className="m-close" onClick={closeModal}>✕</button>
        </div>
        <div className="m-body">
          <div className="form-col">
            <div>
              <div className="f-label">主机 host</div>
              <input
                className="f-input"
                placeholder="192.168.1.100 / jump.example.com"
                value={host}
                onChange={(e) => setHost(e.target.value)}
              />
            </div>
            <div>
              <div className="f-label">用户 user</div>
              <input
                className="f-input"
                placeholder="root"
                value={user}
                onChange={(e) => setUser(e.target.value)}
              />
            </div>
            <div>
              <div className="f-label">密钥路径 keyPath</div>
              <input
                className="f-input"
                placeholder="~/.ssh/id_ed25519"
                value={keyPath}
                onChange={(e) => setKeyPath(e.target.value)}
              />
            </div>
          </div>
          <div className="m-note">host / 用户 / 密钥路径 · 密码不走正门（keyPath 引用）</div>
          {err && <div className="m-error">✗ {err}</div>}
          <div className="m-actions">
            <button className="btn" onClick={closeModal}>取消</button>
            <button
              className="btn primary"
              onClick={() => {
                if (!host.trim() || !user.trim() || !keyPath.trim()) {
                  setErr('host / 用户 / 密钥路径 必填');
                  return;
                }
                void submitSsh(host.trim(), user.trim(), keyPath.trim());
              }}
            >
              连接
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── VM 认领（mock） ────────────────────────────────────────────────────

function AdoptModal({ recipeId }: { recipeId: string }): React.JSX.Element {
  const closeModal = useGuiStore((s) => s.closeModal);
  const showToast = useGuiStore((s) => s.showToast);
  const [vmx, setVmx] = useState('');
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');

  return (
    <div className="modal-backdrop open">
      <div className="modal">
        <div className="m-head">
          <span className="m-title">认领已有 VM · adopt</span>
          <span className="m-sub">{recipeId}</span>
          <button className="m-close" onClick={closeModal}>✕</button>
        </div>
        <div className="m-body">
          <div className="form-col">
            <div>
              <div className="f-label">vmx 路径</div>
              <input
                className="f-input"
                placeholder="D:\VMs\pwn-vm\pwn-vm.vmx"
                value={vmx}
                onChange={(e) => setVmx(e.target.value)}
              />
            </div>
            <div>
              <div className="f-label">guest 用户</div>
              <input className="f-input" placeholder="root" value={user} onChange={(e) => setUser(e.target.value)} />
            </div>
            <div>
              <div className="f-label">guest 密码（现场输入 · 不落盘）</div>
              <input
                className="f-input"
                type="password"
                placeholder="••••••••"
                value={pass}
                onChange={(e) => setPass(e.target.value)}
              />
            </div>
          </div>
          <div className="m-note">
            认领流程：连通测试 → 初始化 → 快照 zhishi-clean → 登记 vmTemplates（MVP mock）
          </div>
          <div className="m-actions">
            <button className="btn" onClick={closeModal}>取消</button>
            <button
              className="btn primary"
              onClick={() => {
                if (!vmx.trim() || !user.trim() || !pass.trim()) {
                  showToast('vmx / guest 用户 / 密码 必填（MVP mock 演示）');
                  return;
                }
                setPass('');
                closeModal();
                showToast(`VM 认领（mock）：${recipeId} 已登记演示条目`);
              }}
            >
              认领
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 新建环境向导 ──────────────────────────────────────────────────────

function NewEnvModal(): React.JSX.Element {
  const recipes = useGuiStore((s) => s.recipes);
  const closeModal = useGuiStore((s) => s.closeModal);
  const setModal = useGuiStore((s) => s.setModal);

  return (
    <div className="modal-backdrop open">
      <div className="modal">
        <div className="m-head">
          <span className="m-title">新建环境</span>
          <span className="m-sub">选择一个环境类型，构建全自动</span>
          <button className="m-close" onClick={closeModal}>✕</button>
        </div>
        <div className="m-body">
          {recipes.length === 0 && <div className="ov-empty">加载配方中…（bundled-environments）</div>}
          {recipes.map((r) => (
            <div
              className="np-item"
              key={r.id}
              onClick={() => {
                setModal(
                  r.base === 'vm'
                    ? { kind: 'adopt', recipeId: r.id }
                    : { kind: 'boot', recipeId: r.id },
                );
              }}
            >
              <span className="np-name">{r.id}</span>
              <span className="np-tools">{r.tools.join(' · ')}</span>
              <span className="np-base">{r.base ?? 'docker'}</span>
            </div>
          ))}
        </div>
        <div className="m-foot">
          <button className="btn" style={{ width: '100%' }} onClick={() => setModal({ kind: 'ssh' })}>
            🔌 通过 SSH 连接已有主机…
          </button>
          <div className="m-foot-note">host / 用户 / 密钥路径 · 密码不走正门（keyPath 引用）</div>
        </div>
      </div>
    </div>
  );
}

export function Modal(): React.JSX.Element | null {
  const modal = useGuiStore((s) => s.modal);
  if (!modal) return null;
  switch (modal.kind) {
    case 'new-env':
      return <NewEnvModal />;
    case 'ssh':
      return <SshModal />;
    case 'adopt':
      return <AdoptModal recipeId={modal.recipeId ?? 'vm'} />;
    case 'boot':
      return <BootModalInner recipeId={modal.recipeId ?? ''} />;
  }
}
