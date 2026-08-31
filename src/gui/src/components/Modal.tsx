/**
 * 模态（1.3.1 ⑤ 接真 + ④ 参数收集；1.3.7 场景 2 四步向导）：
 *   - 新建环境向导：四步（选来源 → 收参 → 确认 → 执行），状态机/payload
 *     构造/域映射在 model/env-wizard.ts；执行分发在 store.wizardExecute
 *   - boot：真实 environment/up + 轮询 environment/ps 推阶段（store.bootEnv）；
 *     向导的配方来源执行步复用此模态承载进度（bootOpts 透传 VM 凭据）
 *   - SSH 接入：向导内的「手动 SSH」来源步（environment/add，补齐
 *     port/name/osFamily/recipeId）；旧 SshModal 已随 1.3.8 B15 删除
 *     （modal kind 'ssh' 无触发点，submitSsh 的 id 拼 user@host 过不了
 *     registry 校验）
 *   - adopt：environment/adopt（真实——连通 → 初始化 → 快照 → vmTemplates）
 *   - slash-args：/snapshot /rollback /extract 的参数收集
 *   - pick-message：/rewind /fork 的消息选择（wire id 来源：replay srvId）
 *   - env-remove：环境删除确认（1.3.7 补口；驱动文案/确认强度在
 *     model/env-remove——hyperv/vbox 删 VM 实例形态需输入环境名二次确认）
 *   - env-down：环境停止确认（1.3.8 ①；VM 关机/容器停止的有损操作，文案在
 *     model/env-down）
 *   - 向导 Step 2/3：配方生命周期差异（1.3.8 ③a，model/env-wizard::
 *     recipeLifecycleNote）+ 打法摘要 workflowSummary 默认折叠（1.3.8 ③b）
 */

import { useEffect, useMemo, useState } from 'react';
import type React from 'react';

import { selectCurrentSession, useGuiStore } from '../store/useGuiStore';
import { bootStages } from '../model/envs';
import { envRemovePlan } from '../model/env-remove';
import { envDownPlan } from '../model/env-down';
import { addRecipeBinding, boundRecipeIds, removeRecipeBinding } from '../model/env-recipes';
import { AutoRunModal } from './AutoRunModals';
import {
  recipeLifecycleNote,
  recipesForSource,
  wizardDiscoveredItems,
  wizardStepError,
  wizardSummaryRows,
  WIZARD_SOURCE_CARDS,
} from '../model/env-wizard';
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

  // 挂载即发起真实 up（重复打开会重发请求；幂等兜底在服务端 environment/up，
  // store 层无去抖）。
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
          {/* G-02（1.3.10）：构建进行中 Esc 已拦截（store.esc 不动模态）、✕
              disabled——构建在服务端继续，关闭 GUI 窗口也不中断。 */}
          {running && <div className="m-hint">构建进行中，关闭窗口不影响构建</div>}
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

// ── 1.3.7 场景 2：新建环境四步向导（状态机在 model/env-wizard.ts） ────────

const WIZARD_STEP_TITLES = ['① 选来源', '② 参数', '③ 确认', '④ 执行'];

/** 1.3.8 ③b：配方打法摘要（workflowSummary，SKILL.md 正文提炼）默认折叠可见。 */
function RecipeWorkflowSummary({ recipe }: { recipe: Recipe | undefined }): React.JSX.Element | null {
  if (!recipe?.workflowSummary) return null;
  return (
    <details className="wf-summary">
      <summary>打法摘要（{recipe.id}）——展开看该环境的标准打法</summary>
      <div className="m-note wf-body">{recipe.workflowSummary}</div>
    </details>
  );
}

function NewEnvModal(): React.JSX.Element | null {
  const wizard = useGuiStore((s) => s.wizard);
  const recipes = useGuiStore((s) => s.recipes);
  const domains = useGuiStore((s) => s.domains);
  const envs = useGuiStore((s) => s.envs);
  const discoveredDocker = useGuiStore((s) => s.discoveredDocker);
  const discoveredVm = useGuiStore((s) => s.discoveredVm);
  const closeModal = useGuiStore((s) => s.closeModal);
  const openAdopt = useGuiStore((s) => s.openAdopt);
  const wizardPickSource = useGuiStore((s) => s.wizardPickSource);
  const wizardSetParam = useGuiStore((s) => s.wizardSetParam);
  const wizardNextStep = useGuiStore((s) => s.wizardNextStep);
  const wizardBackStep = useGuiStore((s) => s.wizardBackStep);
  const wizardExecute = useGuiStore((s) => s.wizardExecute);

  if (!wizard) return null;
  const p = wizard.params;
  const source = wizard.source;
  // 1.3.7 实机修复 A：同族匹配（已登记禁勾选）在 model 层；组件复用同一份
  // 视图模型做「VM 条目 address 必填」的本地校验（wizardStepError 是纯状态机，
  // 拿不到 discover 数据源）。
  const discoveredItems =
    source === 'discovered' ? wizardDiscoveredItems(discoveredDocker, discoveredVm, envs) : [];
  const selectedDiscovered = discoveredItems.find((it) => it.key === p.discoveredKey);
  const stepErr =
    wizardStepError(wizard) ??
    (wizard.step === 2 && selectedDiscovered?.isVm && !p.discoveredAddress.trim()
      ? '请填 VM 的 guest 地址（exec/探测通道前提，缺了探测走不通）'
      : null);

  const recipeSelect = (value: string, key: 'sshRecipeId' | 'discoveredRecipeId', label: string) => (
    <div>
      <div className="f-label">{label}</div>
      <select className="f-input" value={value} onChange={(e) => wizardSetParam(key, e.target.value)}>
        <option value="">（不绑定）</option>
        {recipes.map((r) => (
          <option value={r.id} key={r.id}>{r.id}</option>
        ))}
      </select>
    </div>
  );

  let body: React.JSX.Element;
  if (wizard.step === 1) {
    body = (
      <>
        {WIZARD_SOURCE_CARDS.map((c) => (
          <div className="np-item" key={c.source} onClick={() => wizardPickSource(c.source)}>
            <span className="np-name">{c.title}</span>
            <span className="np-tools">{c.detail}</span>
          </div>
        ))}
        <div className="m-hint">Esc 取消 · 全部来源参数带默认值，≤3 次点击到完成</div>
      </>
    );
  } else if (wizard.step === 2 && (source === 'docker-recipe' || source === 'vm-recipe')) {
    const list = recipesForSource(source, recipes);
    const selectedRecipe = list.find((r) => r.id === p.recipeId);
    body = (
      <>
        {list.length === 0 && <div className="ov-empty">加载配方中…（bundled-environments）</div>}
        {list.map((r) => (
          <div
            className={`np-item ${p.recipeId === r.id ? 'sel' : ''}`}
            key={r.id}
            onClick={() => {
              wizardSetParam('recipeId', r.id);
              if (source === 'vm-recipe' && r.vmUser) wizardSetParam('vmUser', r.vmUser);
            }}
          >
            <span className="np-name">{r.id}</span>
            <span className="np-tools">{r.tools.join(' · ') || '（无工具声明）'}</span>
            <span className="np-base">{r.base ?? 'docker'}</span>
          </div>
        ))}
        {selectedRecipe && (
          <div className="m-hint">
            生命周期：{recipeLifecycleNote(source === 'vm-recipe' ? 'vm' : selectedRecipe.base)}
          </div>
        )}
        <RecipeWorkflowSummary recipe={selectedRecipe} />
        {source === 'vm-recipe' && (
          <div className="form-col" style={{ marginTop: 10 }}>
            <div>
              <div className="f-label">guest 用户（可选；缺省取配方/vmTemplates）</div>
              <input
                className="f-input"
                placeholder="root"
                value={p.vmUser}
                onChange={(e) => wizardSetParam('vmUser', e.target.value)}
              />
            </div>
            <div>
              <div className="f-label">密钥路径（可选）</div>
              <input
                className="f-input"
                placeholder="~/.ssh/id_ed25519"
                value={p.vmKeyPath}
                onChange={(e) => wizardSetParam('vmKeyPath', e.target.value)}
              />
            </div>
            <div className="m-hint">
              已有装好系统的 VM？模板养成与环境接入是两件事——
              <button className="btn" onClick={() => openAdopt(p.recipeId)}>改为认领已有 VM（adopt）</button>
            </div>
          </div>
        )}
      </>
    );
  } else if (wizard.step === 2 && source === 'discovered') {
    // 1.3.7 实机修复 A：已登记条目禁勾选 + 行内标注，防同一 VM/容器重复登记。
    const items = discoveredItems;
    const selected = selectedDiscovered;
    body = (
      <>
        {items.length === 0 && (
          <div className="ov-empty">本机未发现可接入环境（discover 扫描为空）——可上一步换来源</div>
        )}
        {items.map((it) => (
          <div
            className={`np-item ${p.discoveredKey === it.key ? 'sel' : ''} ${it.registeredAs ? 'gated' : ''}`}
            key={it.key}
            onClick={() => {
              if (it.registeredAs) return; // 已登记，不可重复勾选
              wizardSetParam('discoveredKey', it.key);
              // docker 条目无 address 语义——切走时清掉残留值
              if (!it.isVm) wizardSetParam('discoveredAddress', '');
            }}
          >
            <span className="np-name">{it.label}</span>
            <span className="np-tools">{it.detail}</span>
          </div>
        ))}
        <div className="form-col" style={{ marginTop: 10 }}>
          {selected?.isVm && (
            <div>
              <div className="f-label">guest 地址 address（VM 必填——exec/探测通道前提）</div>
              <input
                className="f-input"
                placeholder="192.168.56.20"
                value={p.discoveredAddress}
                onChange={(e) => wizardSetParam('discoveredAddress', e.target.value)}
              />
            </div>
          )}
          <div>
            <div className="f-label">guest 用户（可选）</div>
            <input
              className="f-input"
              placeholder="root"
              value={p.discoveredUser}
              onChange={(e) => wizardSetParam('discoveredUser', e.target.value)}
            />
          </div>
          <div>
            <div className="f-label">密钥路径（可选）</div>
            <input
              className="f-input"
              placeholder="~/.ssh/id_ed25519"
              value={p.discoveredKeyPath}
              onChange={(e) => wizardSetParam('discoveredKeyPath', e.target.value)}
            />
          </div>
          {recipeSelect(p.discoveredRecipeId, 'discoveredRecipeId', '绑定配方（可选——决定域归属）')}
        </div>
      </>
    );
  } else if (wizard.step === 2 && source === 'ssh') {
    body = (
      <div className="form-col">
        <div>
          <div className="f-label">主机 host</div>
          <input
            className="f-input"
            placeholder="192.168.1.100 / jump.example.com"
            value={p.sshHost}
            onChange={(e) => wizardSetParam('sshHost', e.target.value)}
          />
        </div>
        <div>
          <div className="f-label">用户 user</div>
          <input
            className="f-input"
            placeholder="root"
            value={p.sshUser}
            onChange={(e) => wizardSetParam('sshUser', e.target.value)}
          />
        </div>
        <div>
          <div className="f-label">密钥路径 keyPath</div>
          <input
            className="f-input"
            placeholder="~/.ssh/id_ed25519"
            value={p.sshKeyPath}
            onChange={(e) => wizardSetParam('sshKeyPath', e.target.value)}
          />
        </div>
        <div>
          <div className="f-label">端口 port（可选，缺省 22）</div>
          <input
            className="f-input"
            placeholder="22"
            value={p.sshPort}
            onChange={(e) => wizardSetParam('sshPort', e.target.value)}
          />
        </div>
        <div>
          <div className="f-label">名称 name（可选，展示用）</div>
          <input
            className="f-input"
            placeholder="跳板机"
            value={p.sshName}
            onChange={(e) => wizardSetParam('sshName', e.target.value)}
          />
        </div>
        <div>
          <div className="f-label">OS 家族（可选）</div>
          <select
            className="f-input"
            value={p.sshOsFamily}
            onChange={(e) => wizardSetParam('sshOsFamily', e.target.value)}
          >
            <option value="">（未知）</option>
            <option value="linux">linux</option>
            <option value="windows">windows</option>
          </select>
        </div>
        {recipeSelect(p.sshRecipeId, 'sshRecipeId', '绑定配方（可选——决定域归属）')}
        <div className="m-note">host / 用户 / 密钥路径 必填 · 密码不走正门（keyPath 引用）</div>
      </div>
    );
  } else if (wizard.step === 3) {
    const rows = wizardSummaryRows(wizard, { recipes, domains, envs });
    const confirmRecipe =
      source === 'docker-recipe' || source === 'vm-recipe'
        ? recipes.find((r) => r.id === p.recipeId)
        : undefined;
    body = (
      <>
        <div className="wiz-confirm">
          {rows.map((r) => (
            <div className="wiz-confirm-row" key={r.label}>
              <span className="wc-label">{r.label}</span>
              <span className="wc-value">{r.value}</span>
            </div>
          ))}
        </div>
        <RecipeWorkflowSummary recipe={confirmRecipe} />
        <div className="m-hint">确认无误后进执行步——构建全自动，失败即停，绝不半进</div>
      </>
    );
  } else {
    const actionText =
      source === 'docker-recipe' || source === 'vm-recipe'
        ? 'environment/up 全自动构建（进度走构建模态轮询）'
        : source === 'discovered'
          ? 'environment/add 登记入侧栏（运行中则自动切入）'
          : 'environment/add 登记 SSH 主机';
    body = (
      <>
        <div className="wiz-confirm">
          <div className="wiz-confirm-row">
            <span className="wc-label">动作</span>
            <span className="wc-value">{actionText}</span>
          </div>
        </div>
        <div className="m-hint">点「开始创建」一键发起；此后零动手</div>
      </>
    );
  }

  return (
    <div className="modal-backdrop open">
      <div className="modal">
        <div className="m-head">
          <span className="m-title">新建环境</span>
          <span className="m-sub">四步向导 · 参数全带默认值</span>
          <span className="wiz-steps">
            {WIZARD_STEP_TITLES.map((t, i) => (
              <span
                className={`wiz-step ${i + 1 === wizard.step ? 'cur' : i + 1 < wizard.step ? 'done' : ''}`}
                key={t}
              >
                {t}
              </span>
            ))}
          </span>
          <button className="m-close" onClick={closeModal}>✕</button>
        </div>
        <div className="m-body">
          {body}
          {stepErr && wizard.step === 2 && <div className="m-error">✗ {stepErr}</div>}
          <div className="m-actions">
            {wizard.step > 1 && (
              <button className="btn" onClick={wizardBackStep}>上一步</button>
            )}
            <button className="btn" onClick={closeModal}>取消</button>
            {wizard.step < 3 && wizard.step > 1 && (
              <button className="btn primary" disabled={stepErr !== null} onClick={wizardNextStep}>
                下一步
              </button>
            )}
            {wizard.step === 3 && (
              <button className="btn primary" onClick={wizardNextStep}>确认，去执行</button>
            )}
            {wizard.step === 4 && (
              <button className="btn primary" onClick={() => void wizardExecute()}>开始创建</button>
            )}
          </div>
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

// ── 1.3.7 补口：环境删除确认（文案/确认强度在 model/env-remove） ────────

function EnvRemoveModal(): React.JSX.Element | null {
  const modal = useGuiStore((s) => s.modal);
  const closeModal = useGuiStore((s) => s.closeModal);
  const confirmEnvRemove = useGuiStore((s) => s.confirmEnvRemove);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);

  const target = modal?.envRemove;
  if (!target) return null;
  const plan = envRemovePlan(target);
  const needsType = plan.strength === 'type-name';
  const canConfirm = !needsType || typed.trim() === target.label;

  return (
    <div className="modal-backdrop open">
      <div className="modal">
        <div className="m-head">
          <span className="m-title">
            删除环境 <b className="m-env-name">{target.label}</b>
          </span>
          <span className="m-sub">environment/rm · {target.kind}</span>
          <button className="m-close" onClick={closeModal}>✕</button>
        </div>
        <div className="m-body">
          <div className={plan.danger ? 'm-danger' : 'm-note'}>{plan.body}</div>
          {needsType && (
            <div style={{ marginTop: 10 }}>
              <div className="f-label">输入环境名「{target.label}」确认</div>
              <input
                className="f-input"
                autoFocus
                placeholder={target.label}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
            </div>
          )}
          <div className="m-actions">
            <button className="btn" onClick={closeModal}>取消</button>
            <button
              className={`btn ${plan.danger ? 'danger' : 'primary'}`}
              disabled={!canConfirm || busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await confirmEnvRemove();
                } finally {
                  setBusy(false);
                }
              }}
            >
              {plan.confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 1.3.8 多配方：环境详情（只读信息 + 配方绑定管理；绑定=展示/构建来源） ──

function EnvDetailModal(): React.JSX.Element | null {
  const modal = useGuiStore((s) => s.modal);
  const recipes = useGuiStore((s) => s.recipes);
  const closeModal = useGuiStore((s) => s.closeModal);
  const applyEnvBindings = useGuiStore((s) => s.applyEnvBindings);
  const entry = modal?.envDetail;
  const [pending, setPending] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  // entry 首次进入时初始化 pending（模态切换目标时重置）。
  const entryId = entry?.id;
  useEffect(() => {
    if (!entry) return;
    setPending(boundRecipeIds(entry));
    setDirty(false);
  }, [entryId, entry]);

  if (!entry) return null;

  const primary = entry.recipeId;
  const addable = recipes.filter((r) => !pending.includes(r.id));

  const anchor =
    entry.kind === 'ssh' ? entry.host : entry.kind === 'docker' ? entry.container : entry.vmName;

  return (
    <div className="modal-backdrop open">
      <div className="modal" style={{ width: 'min(520px, 92vw)' }}>
        <div className="m-head">
          <span className="m-title">
            环境详情 <b className="m-env-name">{entry.id}</b>
          </span>
          <span className="m-sub">{entry.kind}</span>
          <button className="m-close" onClick={closeModal}>✕</button>
        </div>
        <div className="m-body">
          <div className="wiz-confirm-row"><span className="wiz-k">定位锚</span><span className="wiz-v">{anchor ?? '—'}</span></div>
          {entry.address && (
            <div className="wiz-confirm-row"><span className="wiz-k">地址</span><span className="wiz-v">{entry.address}</span></div>
          )}
          {entry.vmx && (
            <div className="wiz-confirm-row"><span className="wiz-k">vmx</span><span className="wiz-v">{entry.vmx}</span></div>
          )}
          {entry.user && (
            <div className="wiz-confirm-row"><span className="wiz-k">用户</span><span className="wiz-v">{entry.user}</span></div>
          )}
          {entry.keyPath && (
            <div className="wiz-confirm-row"><span className="wiz-k">私钥</span><span className="wiz-v">{entry.keyPath}</span></div>
          )}
          {entry.osFamily && (
            <div className="wiz-confirm-row"><span className="wiz-k">OS</span><span className="wiz-v">{entry.osFamily}</span></div>
          )}
          {entry.capabilityDomains && entry.capabilityDomains.length > 0 && (
            <div className="wiz-confirm-row">
              <span className="wiz-k">能力（推导）</span>
              <span className="wiz-v">{entry.capabilityDomains.join(' · ')}</span>
            </div>
          )}
          {entry.toolCheck && entry.toolCheck.missing.length > 0 && (
            <div className="wiz-confirm-row">
              <span className="wiz-k">工具漂移</span>
              <span className="wiz-v">缺：{entry.toolCheck.missing.join('、')}</span>
            </div>
          )}

          <div className="f-label" style={{ marginTop: 12 }}>配方绑定（绑定 = 展示/构建来源，不改变能力判定）</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {pending.map((rid) => {
              const isPrimary = rid === primary;
              return (
                <span key={rid} className={isPrimary ? 'cap' : 'cap reg'}>
                  {rid}
                  {isPrimary ? ' ⓟ' : ''}
                  {!isPrimary && (
                    <button
                      className="chip-x"
                      aria-label={`解绑 ${rid}`}
                      onClick={() => {
                        const r = removeRecipeBinding(pending, rid, primary);
                        if (!r.ok) return;
                        setPending(r.next);
                        setDirty(true);
                      }}
                    >
                      ×
                    </button>
                  )}
                </span>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <select
              className="f-input"
              value=""
              onChange={(e) => {
                const v = e.target.value;
                if (!v) return;
                setPending(addRecipeBinding(pending, v));
                setDirty(true);
                e.target.value = '';
              }}
            >
              <option value="">＋ 追加绑定配方…</option>
              {addable.map((r) => (
                <option key={r.id} value={r.id}>{r.id}</option>
              ))}
            </select>
          </div>

          <div className="m-actions">
            <button className="btn" onClick={closeModal}>关闭</button>
            <button
              className="btn primary"
              disabled={!dirty || busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await applyEnvBindings(pending);
                } finally {
                  setBusy(false);
                }
              }}
            >
              应用绑定
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 1.3.8 ①：环境停止确认（文案在 model/env-down；有损操作——VM 关机/容器停止） ──

function EnvDownModal(): React.JSX.Element | null {
  const modal = useGuiStore((s) => s.modal);
  const closeModal = useGuiStore((s) => s.closeModal);
  const confirmEnvDown = useGuiStore((s) => s.confirmEnvDown);
  const [busy, setBusy] = useState(false);

  const target = modal?.envDown;
  if (!target) return null;
  const plan = envDownPlan(target);

  return (
    <div className="modal-backdrop open">
      <div className="modal">
        <div className="m-head">
          <span className="m-title">
            停止环境 <b className="m-env-name">{target.label}</b>
          </span>
          <span className="m-sub">environment/down · {target.kind}</span>
          <button className="m-close" onClick={closeModal}>✕</button>
        </div>
        <div className="m-body">
          <div className="m-danger">{plan.body}</div>
          <div className="m-actions">
            <button className="btn" onClick={closeModal}>取消</button>
            <button
              className="btn danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await confirmEnvDown();
                } finally {
                  setBusy(false);
                }
              }}
            >
              {plan.confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 1.4.9：环境补齐确认（重放配方安装脚本——改机器状态的显式动作；幂等化后已装跳过） ──

function EnvProvisionModal(): React.JSX.Element | null {
  const modal = useGuiStore((s) => s.modal);
  const closeModal = useGuiStore((s) => s.closeModal);
  const confirmEnvProvision = useGuiStore((s) => s.confirmEnvProvision);
  const [busy, setBusy] = useState(false);

  const target = modal?.envProvision;
  if (!target) return null;

  return (
    <div className="modal-backdrop open">
      <div className="modal">
        <div className="m-head">
          <span className="m-title">
            补齐环境 <b className="m-env-name">{target.label}</b>
          </span>
          <span className="m-sub">environment/setup · 重放配方安装脚本</span>
          <button className="m-close" onClick={closeModal}>✕</button>
        </div>
        <div className="m-body">
          <div>
            将在该环境内执行绑定配方的安装脚本（VM→setup.sh / 容器配方→provision.sh），
            装齐缺失工具；已安装的工具会跳过（幂等）。脚本含 sudo 段时需要该环境用户免密 sudo。
            完成后自动重推能力集合。
          </div>
          <div className="m-note">
            当前缺失（{target.missing.length}）：{target.missing.join('、')}
          </div>
          <div className="m-actions">
            <button className="btn" onClick={closeModal}>取消</button>
            <button
              className="btn primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await confirmEnvProvision();
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? '补齐中（可能要几分钟）…' : '开始补齐'}
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
    case 'env-remove':
      return <EnvRemoveModal />;
    case 'env-down':
      return <EnvDownModal />;
    case 'env-provision':
      return <EnvProvisionModal />;
    case 'env-detail':
      return <EnvDetailModal />;
    case 'auto-run-start':
    case 'auto-run-stop':
      return <AutoRunModal />;
  }
}
