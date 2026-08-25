/**
 * 模态（1.3.1 ⑤ 接真 + ④ 参数收集）：
 *   - 新建环境向导：配方列表（environment/recipes 真实数据）
 *   - boot：真实 environment/up + 轮询 environment/ps 推阶段（store.bootEnv）
 *   - SSH 接入：environment/add（真实落盘，保持）
 *   - adopt：environment/adopt（真实——连通 → 初始化 → 快照 → vmTemplates）
 *   - slash-args：/snapshot /rollback /extract 的参数收集
 *   - pick-message：/rewind /fork 的消息选择（wire id 来源：replay srvId）
 */

import { useEffect, useMemo, useState } from 'react';
import type React from 'react';

import { selectCurrentSession, useGuiStore } from '../store/useGuiStore';
import { bootStages } from '../model/envs';
import { forkTargets, rewindTargets, SLASH_ROUTES } from '../model/slash-routes';
import type { Recipe } from '../client/api';

const BOOT_STEPS = '①②③④⑤⑥⑦⑧';

function fallbackRecipe(id: string | undefined): Recipe {
  return { id: id ?? 'env', name: id ?? 'env', tools: [] };
}

// ── 1.3.1 ⑤：构建进度（真实 environment/up + ps 轮询推阶段） ──────────

function BootModalInner({ recipeId }: { recipeId: string }): React.JSX.Element {
  const showToast = useGuiStore((s) => s.showToast);
  const closeModal = useGuiStore((s) => s.closeModal);
  const bootEnv = useGuiStore((s) => s.bootEnv);
  const boot = useGuiStore((s) => s.boot);
  const recipe = useGuiStore((s) => s.recipes.find((r) => r.id === recipeId)) ?? fallbackRecipe(recipeId);

  const stages = useMemo(() => bootStages(recipe.base), [recipe.base]);

  // 挂载即发起真实 up（幂等：重复打开重跑；store.bootEnv 内部去抖）。
  useEffect(() => {
    void bootEnv(recipeId);
  }, [recipeId, bootEnv]);

  const running = boot?.recipeId === recipeId && boot.status === 'running';
  const done = boot?.recipeId === recipeId && boot.status === 'done';
  const failed = boot?.recipeId === recipeId && boot.status === 'failed';
  const stage = boot?.recipeId === recipeId ? boot.stage : 0;

  return (
    <div className="modal-backdrop open">
      <div className="modal">
        <div className="m-head">
          <span className="m-title">
            构建环境 <b className="m-env-name">{recipe.id}</b>
          </span>
          <span className="m-sub">{recipe.base} · 新建环境 · environment/up 真实构建</span>
          <button className="m-close" onClick={closeModal} disabled={running}>✕</button>
        </div>
        <div className="m-body">
          {stages.map((name, i) => (
            <div className={`bs ${i < stage ? 'done' : i === stage ? 'cur' : ''}`} key={name}>
              <span className="bs-idx">{BOOT_STEPS[i] ?? i + 1}</span>
              <span className="bs-name">{name}</span>
              <span className="bs-state">
                {i < stage ? '完成' : i === stage ? <span className="spinner" /> : '待 …'}
              </span>
            </div>
          ))}
          {failed && boot?.error && <div className="m-error">✗ {boot.error}</div>}
          <div className="m-hint">Esc 取消 · 失败即停，绝不半进</div>
          {(done || failed) && (
            <div className="m-actions">
              <button
                className="btn"
                onClick={() => {
                  if (failed) closeModal();
                  else {
                    closeModal();
                    showToast(`✓ 环境 ${recipe.id} 已就绪——侧栏「运行中」组切换进入`);
                  }
                }}
              >
                关闭
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── SSH 接入（真实 environment/add，保持） ──────────────────────────────

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

// ── VM 认领（真实 environment/adopt） ───────────────────────────────────

function AdoptModal({ recipeId }: { recipeId: string }): React.JSX.Element {
  const closeModal = useGuiStore((s) => s.closeModal);
  const submitAdopt = useGuiStore((s) => s.submitAdopt);
  const [vmx, setVmx] = useState('');
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');

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
            认领流程：连通测试 → 初始化（setup）→ 快照 zhishi-clean → 登记 vmTemplates（真实 environment/adopt）
          </div>
          {err && <div className="m-error">✗ {err}</div>}
          <div className="m-actions">
            <button className="btn" onClick={closeModal}>取消</button>
            <button
              className="btn primary"
              onClick={() => {
                if (!vmx.trim() || !user.trim()) {
                  setErr('vmx / guest 用户必填（密码可留空走 keyPath）');
                  return;
                }
                setPass('');
                void submitAdopt(vmx.trim(), user.trim(), '', pass);
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

// ── 1.3.1 ④：slash 参数收集（snapshot/rollback/extract） ───────────────

function SlashArgsModal(): React.JSX.Element | null {
  const modal = useGuiStore((s) => s.modal);
  const closeModal = useGuiStore((s) => s.closeModal);
  const submitSlashArg = useGuiStore((s) => s.submitSlashArg);
  const [value, setValue] = useState('');

  const command = modal?.command;
  if (!command) return null;
  const route = SLASH_ROUTES[command];

  return (
    <div className="modal-backdrop open">
      <div className="modal">
        <div className="m-head">
          <span className="m-title">/{route.command} · {route.argTitle}</span>
          <span className="m-sub">参数收集</span>
          <button className="m-close" onClick={closeModal}>✕</button>
        </div>
        <div className="m-body">
          <div className="f-label">{route.argPlaceholder}</div>
          <input
            className="f-input"
            autoFocus
            placeholder={route.argPlaceholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void submitSlashArg(value);
              }
            }}
          />
          <div className="m-actions">
            <button className="btn" onClick={closeModal}>取消</button>
            <button className="btn primary" onClick={() => void submitSlashArg(value)}>
              执行
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 1.3.1 ④：消息选择（rewind/fork） ───────────────────────────────────

function PickMessageModal(): React.JSX.Element | null {
  const modal = useGuiStore((s) => s.modal);
  const closeModal = useGuiStore((s) => s.closeModal);
  const pickMessageTarget = useGuiStore((s) => s.pickMessageTarget);
  const session = useGuiStore(selectCurrentSession);

  const command = modal?.command;
  const route = command ? SLASH_ROUTES[command] : null;
  const targets = useMemo(() => {
    if (!command) return [];
    return command === 'rewind' ? rewindTargets(session.items) : forkTargets(session.items);
  }, [command, session.items]);

  if (!command || !route) return null;

  return (
    <div className="modal-backdrop open">
      <div className="modal">
        <div className="m-head">
          <span className="m-title">/{route.command} · {route.argTitle}</span>
          <span className="m-sub">{targets.length} 条候选（wire 消息 id）</span>
          <button className="m-close" onClick={closeModal}>✕</button>
        </div>
        <div className="m-body">
          {targets.length === 0 && <div className="ov-empty">当前会话没有可{command === 'rewind' ? '回退' : '分叉'}的消息</div>}
          {targets.map((t) => (
            <div className="pm-item" key={t.id} onClick={() => void pickMessageTarget(t.id)}>
              <span className="pm-label">{t.label}</span>
              <span className="pm-id mono">{t.id}</span>
            </div>
          ))}
          <div className="m-actions">
            <button className="btn" onClick={closeModal}>取消</button>
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

// ── 1.3.2 ①：promote（决策块 → expert/add 入专家库，预填小表单） ──────

/** expert/add 的 domain 闭集（src/shared/research-kinds.ts::RESEARCH_TASK_KINDS）。 */
const EXPERT_DOMAINS = ['binary', 'pentest', 'ai-security', 'redteam', 'malware', 'whitebox', 'intel', 'ctf'];
/** expert/add 的 kind 闭集（src/shared/expert-validate.ts::EXPERT_ENTRY_KINDS）。 */
const EXPERT_KINDS = ['idea', 'technique', 'sop'];

function PromoteModal(): React.JSX.Element | null {
  const modal = useGuiStore((s) => s.modal);
  const closeModal = useGuiStore((s) => s.closeModal);
  const submitPromote = useGuiStore((s) => s.submitPromote);
  const showToast = useGuiStore((s) => s.showToast);
  const [domain, setDomain] = useState('binary');
  const [kind, setKind] = useState('sop');
  const [title, setTitle] = useState('');
  const [applicability, setApplicability] = useState('');
  const [criteria, setCriteria] = useState('');
  const [content, setContent] = useState('');
  const [reviewer, setReviewer] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const prefill = modal?.prefill;
  const [seeded, setSeeded] = useState(false);
  // 预填一次（title=question、applicability=场景、criteria=选择+备注 草稿）。
  useEffect(() => {
    if (!prefill || seeded) return;
    setTitle(prefill.title);
    setApplicability(prefill.applicability);
    setCriteria(prefill.criteria);
    setContent(prefill.content);
    setSeeded(true);
  }, [prefill, seeded]);

  if (!prefill) return null;

  return (
    <div className="modal-backdrop open">
      <div className="modal">
        <div className="m-head">
          <span className="m-title">入专家库 · <b className="m-env-name">promote</b></span>
          <span className="m-sub">决策沉淀为可验证基准 · expert/add（reviewer 必填）</span>
          <button className="m-close" onClick={closeModal}>✕</button>
        </div>
        <div className="m-body">
          <div className="form-col">
            <div>
              <div className="f-label">domain（研究域）</div>
              <select className="f-input" value={domain} onChange={(e) => setDomain(e.target.value)}>
                {EXPERT_DOMAINS.map((d) => (
                  <option value={d} key={d}>{d}</option>
                ))}
              </select>
            </div>
            <div>
              <div className="f-label">kind（条目类型）</div>
              <select className="f-input" value={kind} onChange={(e) => setKind(e.target.value)}>
                {EXPERT_KINDS.map((k) => (
                  <option value={k} key={k}>{k}</option>
                ))}
              </select>
            </div>
            <div>
              <div className="f-label">title（预填 = 决策问题）</div>
              <input className="f-input" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div>
              <div className="f-label">applicability（适用条件/场景）</div>
              <input
                className="f-input"
                placeholder="什么场景下适用这条基准"
                value={applicability}
                onChange={(e) => setApplicability(e.target.value)}
              />
            </div>
            <div>
              <div className="f-label">criteria（判据 · 预填 = 选择+备注 草稿）</div>
              <textarea className="f-input" rows={3} value={criteria} onChange={(e) => setCriteria(e.target.value)} />
            </div>
            <div>
              <div className="f-label">content（正文 · 预填 = 决策块正文）</div>
              <textarea className="f-input" rows={4} value={content} onChange={(e) => setContent(e.target.value)} />
            </div>
            <div>
              <div className="f-label">reviewer（审定人 · 必填）</div>
              <input
                className="f-input"
                placeholder="你的名字（人审定才进库）"
                value={reviewer}
                onChange={(e) => setReviewer(e.target.value)}
              />
            </div>
          </div>
          {err && <div className="m-error">✗ {err}</div>}
          <div className="m-actions">
            <button className="btn" onClick={closeModal}>取消</button>
            <button
              className="btn primary"
              disabled={busy}
              onClick={async () => {
                if (!title.trim() || !content.trim() || !criteria.trim() || !reviewer.trim()) {
                  setErr('title / content / criteria / reviewer 必填');
                  return;
                }
                setBusy(true);
                try {
                  const res = await submitPromote({
                    domain,
                    kind,
                    title: title.trim(),
                    applicability: applicability.trim(),
                    criteria: criteria.trim(),
                    content: content.trim(),
                    reviewer: reviewer.trim(),
                  });
                  showToast(res.message);
                  if (res.ok) closeModal();
                  else setErr(res.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              入专家库
            </button>
          </div>
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
    case 'slash-args':
      return <SlashArgsModal />;
    case 'pick-message':
      return <PickMessageModal />;
    case 'promote':
      return <PromoteModal />;
  }
}
