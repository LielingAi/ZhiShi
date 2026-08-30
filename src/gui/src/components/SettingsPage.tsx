/**
 * 设置页（1.3.1 ⑥）：页签接真——
 *   模型     model/list + model/set-key（隐藏输入模态）+ set-default + verify
 *   情报     intel/status + intel/update（mode 选择）+
 *            intel/config-update（1.3.2：配置部分更新，只改传入字段）
 *   专家知识 expert/search + expert/list + expert/add（JSON/YAML 导入）+
 *            expert/drafts + expert/review（草稿审定）
 *   研究记录 research/list
 *   外观     theme 切换（1.3.2：深浅色，localStorage 持久化；原占位已接真）
 *
 * 关于页签保留（v19 形态）。Esc 经 Esc 链 close-page 返回主会话区
 * （与主会话区互斥：page === 'settings' 时主区不渲染）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';

import { GUI_VERSION } from '../../../shared/constants';
import { getSettingsClient, useGuiStore } from '../store/useGuiStore';
import * as api from '../client/api';
import type { ExpertDraft, ExpertSummary, ModelProvider, ResearchEventRow } from '../client/api';
import { buildCustomProviderPayload } from '../model/custom-provider';
import {
  buildIntelConfigPatch,
  INTEL_MODES,
  INTEL_MODE_DEFAULT,
  INTEL_MODE_META,
  type IntelConfigForm,
  type IntelMode,
  type IntelResolvedConfig,
} from '../model/intel-config';
import { StateHint } from './StateHint';

const NAV = [
  { id: 'model', icon: '◇', label: '模型', disabled: false },
  { id: 'intel', icon: '◈', label: '情报', disabled: false },
  { id: 'expert', icon: '◇', label: '专家知识', disabled: false },
  { id: 'research', icon: '✎', label: '研究记录', disabled: false },
  { id: 'appearance', icon: '◐', label: '外观', disabled: false },
  { id: 'about', icon: 'ⓘ', label: '关于', disabled: false },
] as const;

// ── 模型页签 ──────────────────────────────────────────────────────────

function ModelTab(): React.JSX.Element {
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [current, setCurrent] = useState<{ providerId?: string; modelId?: string } | null>(null);
  const [keyProvider, setKeyProvider] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const showToast = useGuiStore((s) => s.showToast);

  const reload = useCallback(async () => {
    const c = getSettingsClient();
    if (!c) return;
    try {
      const res = await api.fetchModelList(c);
      setProviders(res.providers);
      setCurrent(res.current ?? null);
    } catch {
      // 拉取失败静默（页面显示空态）。
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <>
      <div className="set-group">
        <div className="sg-title">当前使用</div>
        <div className="set-row">
          <div>
            <div className="sr-label">默认模型</div>
            <div className="sr-desc">切换在主界面状态栏（点击模型名）</div>
          </div>
          <div className="sr-control">
            <span className="sr-status ok">
              {current?.modelId ?? '未设置'}
              {current?.providerId ? `（${current.providerId}）` : ''}
            </span>
          </div>
        </div>
      </div>
      <div className="set-group">
        <div className="sg-title">供应商</div>
        {providers.length === 0 && <StateHint kind="empty" text="暂无供应商" hint="未连接 sidecar 或目录为空" />}
        {providers.map((p) => (
          <div className="set-row" key={p.id}>
            <div>
              <div className="sr-label">{p.id}{p.isBuiltin === false ? '（自定义）' : ''}</div>
              <div className="sr-desc">
                {p.name ?? ''} · {p.models.length} 模型
                {p.status && p.status !== 'not-set' ? ` · ${p.status}` : ''}
              </div>
            </div>
            <div className="sr-control">
              <span className={`sr-status ${p.hasApiKey ? 'ok' : ''}`}>
                {p.hasApiKey ? '✓ 已配 key' : '○ 未配'}
              </span>
              <button className="btn small" onClick={() => setKeyProvider(p.id)}>配置 Key</button>
              <button
                className="btn small"
                onClick={async () => {
                  const c = getSettingsClient();
                  if (!c) return;
                  const res = await api.modelSetDefault(c, p.id);
                  showToast(res.success ? `✓ 默认供应商已设为 ${p.id}` : `失败：${res.error ?? '未知错误'}`);
                  void reload();
                }}
              >
                设默认
              </button>
              <button
                className="btn small"
                onClick={async () => {
                  const c = getSettingsClient();
                  if (!c) return;
                  showToast(`⏳ 验证 ${p.id}…`);
                  const res = await api.modelVerify(c, p.id);
                  showToast(res.success ? `✓ ${res.hint ?? '验证通过'}` : `✗ ${res.error ?? '验证失败'}`);
                }}
              >
                验证
              </button>
              {p.isBuiltin === false && (
                confirmRemove === p.id ? (
                  <>
                    <button
                      className="btn small danger"
                      onClick={async () => {
                        const c = getSettingsClient();
                        if (!c) return;
                        const res = await api.modelRemoveProvider(c, p.id);
                        showToast(res.success ? `✓ 已删除自定义供应商 ${p.id}` : `删除失败：${res.error ?? '未知错误'}`);
                        setConfirmRemove(null);
                        void reload();
                      }}
                    >
                      确认删除
                    </button>
                    <button className="btn small" onClick={() => setConfirmRemove(null)}>取消</button>
                  </>
                ) : (
                  <button className="btn small" onClick={() => setConfirmRemove(p.id)}>删除</button>
                )
              )}
            </div>
          </div>
        ))}
        <div className="set-row">
          <div>
            <div className="sr-label">自定义供应商</div>
            <div className="sr-desc">中转站 / 自建网关等 OpenAI/Anthropic 兼容端点（baseUrl + key + 模型 ID）</div>
          </div>
          <div className="sr-control">
            <button className="btn small primary" onClick={() => setAddOpen(true)}>+ 添加</button>
          </div>
        </div>
      </div>
      {addOpen && (
        <CustomProviderModal
          onClose={() => setAddOpen(false)}
          onSaved={() => {
            setAddOpen(false);
            void reload();
          }}
        />
      )}
      {keyProvider && (
        <KeyConfigModal
          providerId={keyProvider}
          onClose={() => setKeyProvider(null)}
          onSaved={() => {
            setKeyProvider(null);
            void reload();
          }}
        />
      )}
    </>
  );
}

/** 1.4.10 #6：自定义供应商（中转站）表单模态——校验/组装在
 *  model/custom-provider.ts（纯函数），这里只做输入与提交。 */
function CustomProviderModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}): React.JSX.Element {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [protocol, setProtocol] = useState<'openai' | 'anthropic'>('openai');
  const [modelsRaw, setModelsRaw] = useState('');
  const [primaryModel, setPrimaryModel] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const showToast = useGuiStore((s) => s.showToast);

  return (
    <div className="modal-backdrop open">
      <div className="modal" style={{ width: 'min(520px, 92vw)' }}>
        <div className="m-head">
          <span className="m-title">添加自定义供应商</span>
          <span className="m-sub">model/add · 中转站 / 自建网关</span>
          <button className="m-close" onClick={onClose}>✕</button>
        </div>
        <div className="m-body">
          <div className="f-label">ID（英文标识，定后不可改——删除重加即编辑）</div>
          <input className="f-input" autoFocus placeholder="my-relay" value={id} onChange={(e) => setId(e.target.value)} />
          <div className="f-label">名称（展示用）</div>
          <input className="f-input" placeholder="XX 中转站" value={name} onChange={(e) => setName(e.target.value)} />
          <div className="f-label">Base URL（API 端点）</div>
          <input className="f-input" placeholder="https://relay.example.com/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          <div className="f-label">协议（中转站典型 = OpenAI 兼容）</div>
          <select className="f-input" value={protocol} onChange={(e) => setProtocol(e.target.value as 'openai' | 'anthropic')}>
            <option value="openai">OpenAI 兼容（中转站典型）</option>
            <option value="anthropic">Anthropic 兼容</option>
          </select>
          <div className="f-label">模型 ID 列表（逗号/空格/换行分隔；中转站后台可查）</div>
          <textarea
            className="f-input"
            rows={3}
            placeholder="gpt-4o, claude-sonnet-4-5, deepseek-v4-pro"
            value={modelsRaw}
            onChange={(e) => setModelsRaw(e.target.value)}
          />
          <div className="f-label">主模型（缺省 = 列表首个）</div>
          <input className="f-input" placeholder="（可选）" value={primaryModel} onChange={(e) => setPrimaryModel(e.target.value)} />
          <div className="m-note">保存后在列表行内「配置 Key」；设 key 后可「验证」并在主界面状态栏选模型。</div>
          {err && <div className="m-error">✗ {err}</div>}
          <div className="m-actions">
            <button className="btn" onClick={onClose}>取消</button>
            <button className="btn primary" disabled={busy} onClick={() => void save()}>保存</button>
          </div>
        </div>
      </div>
    </div>
  );

  async function save() {
    const built = buildCustomProviderPayload({ id, name, baseUrl, protocol, modelsRaw, primaryModel });
    if (!built.ok) {
      setErr(built.error);
      return;
    }
    setBusy(true);
    try {
      const c = getSettingsClient();
      if (!c) {
        setErr('未连接 sidecar');
        return;
      }
      const res = await api.modelAddProvider(c, built.provider);
      if (!res.success) {
        setErr(res.error ?? '保存失败');
        return;
      }
      showToast(`✓ 自定义供应商 ${id.trim()} 已添加——行内「配置 Key」后可用`);
      onSaved();
    } finally {
      setBusy(false);
    }
  }
}

/** 隐藏输入 key 配置模态（v19 keyconfig 形态）。 */
function KeyConfigModal({
  providerId,
  onClose,
  onSaved,
}: {
  providerId: string;
  onClose: () => void;
  onSaved: () => void;
}): React.JSX.Element {
  const [key, setKey] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const showToast = useGuiStore((s) => s.showToast);

  return (
    <div className="modal-backdrop open">
      <div className="modal" style={{ width: 'min(420px, 90vw)' }}>
        <div className="m-head">
          <span className="m-title">
            配置 Key · <b className="m-env-name">{providerId}</b>
          </span>
          <button className="m-close" onClick={onClose}>✕</button>
        </div>
        <div className="m-body">
          <div className="f-label">隐藏输入 · key 只落 ~/.zhishi/config.json（providerApiKeys）</div>
          <input
            className="f-input"
            type="password"
            autoFocus
            placeholder="sk-…"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy) void save();
            }}
          />
          {err && <div className="m-error">✗ {err}</div>}
          <div className="m-actions">
            <button className="btn" onClick={onClose}>取消</button>
            <button
              className="btn primary"
              disabled={busy}
              onClick={() => void save()}
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  async function save() {
    if (!key.trim()) {
      setErr('key 不能为空');
      return;
    }
    setBusy(true);
    try {
      const c = getSettingsClient();
      if (!c) {
        setErr('未连接 sidecar');
        return;
      }
      const res = await api.modelSetKey(c, providerId, key.trim());
      if (!res.success) {
        setErr(res.error ?? '保存失败');
        return;
      }
      showToast(`✓ ${res.hint ?? `key 已保存（${providerId}）`}`);
      onSaved();
    } finally {
      setBusy(false);
    }
  }
}


function IntelTab(): React.JSX.Element {
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  const [config, setConfig] = useState<IntelResolvedConfig | null>(null);
  const [mode, setMode] = useState<IntelMode>(INTEL_MODE_DEFAULT);
  const [busy, setBusy] = useState(false);
  // 1.3.2 任务二 #4：配置编辑表单（intel/config-update 部分更新）。
  // 1.3.6：初始档位对齐服务端缺省 minimal（旧值 'window' 会在 status
  // 返回前把「时间窗口」误标为当前档——更新一键即发 window）。
  const [cfgForm, setCfgForm] = useState<IntelConfigForm>({
    mode: INTEL_MODE_DEFAULT,
    windowYears: '',
    maxSizeMb: '',
    onlineFallback: true,
  });
  const [savingCfg, setSavingCfg] = useState(false);
  const showToast = useGuiStore((s) => s.showToast);

  const reload = useCallback(async () => {
    const c = getSettingsClient();
    if (!c) return;
    try {
      const data = await api.fetchIntelStatus(c);
      setStatus(data.status ?? null);
      const raw = data.config ?? null;
      const cfgMode: IntelMode =
        raw?.mode === 'window' || raw?.mode === 'full' ? raw.mode : INTEL_MODE_DEFAULT;
      const resolved: IntelResolvedConfig | null = raw
        ? {
            mode: cfgMode,
            windowYears:
              typeof raw.windowYears === 'number' && Number.isFinite(raw.windowYears) && raw.windowYears > 0
                ? raw.windowYears
                : 3,
            maxSizeMb:
              typeof raw.maxSizeMb === 'number' && Number.isFinite(raw.maxSizeMb) && raw.maxSizeMb > 0
                ? raw.maxSizeMb
                : 300,
            onlineFallback: raw.onlineFallback !== false,
          }
        : null;
      setConfig(resolved);
      setMode(cfgMode);
      setCfgForm({
        mode: cfgMode,
        windowYears: raw?.windowYears !== undefined ? String(raw.windowYears) : '',
        maxSizeMb: raw?.maxSizeMb !== undefined ? String(raw.maxSizeMb) : '',
        onlineFallback: raw?.onlineFallback !== false,
      });
    } catch {
      // 静默。
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 配置部分更新：纯函数 diff 出被改字段 → intel/config-update（只传改动）。 */
  const saveConfig = async () => {
    const c = getSettingsClient();
    if (!c) return;
    const built = buildIntelConfigPatch(cfgForm, config);
    if (!built.ok) {
      showToast(`✗ ${built.error}`);
      return;
    }
    if (Object.keys(built.patch).length === 0) {
      showToast('配置无变更');
      return;
    }
    setSavingCfg(true);
    try {
      const res = await api.intelConfigUpdate(c, built.patch);
      showToast(res.success ? '✓ 情报配置已更新' : `✗ ${res.error ?? '更新失败'}`);
      await reload();
    } finally {
      setSavingCfg(false);
    }
  };

  const st = status ?? {};
  const fmtCount = (v: unknown) =>
    typeof v === 'number' ? v.toLocaleString() : String(v ?? '—');

  return (
    <>
      <div className="set-group">
        <div className="sg-title">情报索引 · intel.db</div>
        {st.dbExists === false && (
          <StateHint kind="empty" text="尚未初始化" hint="点「更新」建立索引" />
        )}
        <div className="set-row">
          <div><div className="sr-label">最后更新</div></div>
          <div className="sr-control"><span className="sr-status">{String(st.lastUpdateAt ?? '—')}</span></div>
        </div>
        <div className="set-row">
          <div><div className="sr-label">NVD CVE</div><div className="sr-desc">窗口档</div></div>
          <div className="sr-control"><span className="sr-status">{fmtCount(st.cveCount)} 条</span></div>
        </div>
        <div className="set-row">
          <div><div className="sr-label">exploit-db</div></div>
          <div className="sr-control"><span className="sr-status">{fmtCount(st.exploitCount)} 条</span></div>
        </div>
        <div className="set-row">
          <div><div className="sr-label">nuclei 模板</div></div>
          <div className="sr-control"><span className="sr-status">{fmtCount(st.nucleiCount)} 条</span></div>
        </div>
      </div>
      <div className="set-group">
        <div className="sg-title">更新</div>
        <div className="set-row">
          <div>
            <div className="sr-label">更新索引</div>
            <div className="sr-desc">增量拉取 · 断点续传 · 数据源失败自动多源切换</div>
          </div>
          <div className="sr-control">
            {INTEL_MODES.map((m) => (
              <button
                className={`btn small ${mode === m ? 'mode-on' : ''}`}
                key={m}
                title={`${INTEL_MODE_META[m].desc}（一次性档位，不改已存配置）`}
                onClick={() => setMode(m)}
              >
                {INTEL_MODE_META[m].label}
              </button>
            ))}
            <button
              className="btn small primary"
              disabled={busy}
              onClick={async () => {
                const c = getSettingsClient();
                if (!c) return;
                setBusy(true);
                showToast(`⏳ 更新情报索引（${INTEL_MODE_META[mode].label}）…`);
                try {
                  const res = await api.intelUpdate(c, mode);
                  showToast(res.success ? '✓ 索引已更新' : `✗ ${res.error ?? '更新失败'}`);
                  await reload();
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? '更新中…' : '更新'}
            </button>
          </div>
        </div>
        <div className="intel-mode-notes">
          {INTEL_MODES.map((m) => (
            <div className="imn-line" key={m}>
              <b>{INTEL_MODE_META[m].label}</b>：{INTEL_MODE_META[m].desc}
            </div>
          ))}
        </div>
      </div>
      <div className="set-group">
        <div className="sg-title">配置 · intel（部分更新 → intel/config-update）</div>
        <div className="set-row">
          <div><div className="sr-label">存储分级</div></div>
          <div className="sr-control">
            {INTEL_MODES.map((m) => (
              <button
                className={`btn small ${cfgForm.mode === m ? 'mode-on' : ''}`}
                key={m}
                title={INTEL_MODE_META[m].desc}
                onClick={() => setCfgForm((f) => ({ ...f, mode: m }))}
              >
                {INTEL_MODE_META[m].label}
              </button>
            ))}
          </div>
        </div>
        <div className="set-row">
          <div><div className="sr-label">窗口年数</div></div>
          <div className="sr-control">
            <input
              className="f-input cf-input"
              value={cfgForm.windowYears}
              placeholder={String(config?.windowYears ?? '3')}
              onChange={(e) => setCfgForm((f) => ({ ...f, windowYears: e.target.value }))}
            />
          </div>
        </div>
        <div className="set-row">
          <div><div className="sr-label">大小上限</div></div>
          <div className="sr-control">
            <input
              className="f-input cf-input"
              value={cfgForm.maxSizeMb}
              placeholder={String(config?.maxSizeMb ?? '300')}
              onChange={(e) => setCfgForm((f) => ({ ...f, maxSizeMb: e.target.value }))}
            />
            <span className="sr-status">MB</span>
          </div>
        </div>
        <div className="set-row">
          <div><div className="sr-label">在线回源</div></div>
          <div className="sr-control">
            <button
              className={`btn small ${cfgForm.onlineFallback ? 'mode-on' : ''}`}
              onClick={() => setCfgForm((f) => ({ ...f, onlineFallback: !f.onlineFallback }))}
            >
              {cfgForm.onlineFallback ? '开' : '关'}
            </button>
            <button className="btn small primary" disabled={savingCfg} onClick={() => void saveConfig()}>
              {savingCfg ? '保存中…' : '保存配置'}
            </button>
          </div>
        </div>
        <div className="sr-desc" style={{ padding: '4px 2px' }}>
          注意：「时间窗口」档保存后，下次更新会删除窗口外的历史 CVE（不可恢复）。
        </div>
      </div>
    </>
  );
}

// ── 专家知识页签 ──────────────────────────────────────────────────────

function ExpertTab(): React.JSX.Element {
  const [entries, setEntries] = useState<ExpertSummary[]>([]);
  const [query, setQuery] = useState('');
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [drafts, setDrafts] = useState<ExpertDraft[]>([]);
  const showToast = useGuiStore((s) => s.showToast);

  const reloadList = useCallback(async () => {
    const c = getSettingsClient();
    if (!c) return;
    try {
      const res = await api.expertList(c);
      if (res.success) setEntries(res.data?.entries ?? []);
    } catch {
      // 静默。
    }
  }, []);

  const reloadDrafts = useCallback(async () => {
    const c = getSettingsClient();
    if (!c) return;
    try {
      const res = await api.expertDrafts(c);
      if (res.success) setDrafts(res.data?.drafts ?? []);
    } catch {
      // 静默。
    }
  }, []);

  useEffect(() => {
    void reloadList();
    void reloadDrafts();
  }, [reloadList, reloadDrafts]);

  const search = async () => {
    const c = getSettingsClient();
    if (!c) return;
    const q = query.trim();
    if (!q) {
      await reloadList();
      return;
    }
    const res = await api.expertSearch(c, q);
    if (res.success) setEntries(res.data?.results ?? []);
    else showToast(`搜索失败：${res.error ?? '未知错误'}`);
  };

  return (
    <>
      <div className="set-group">
        <div className="sg-title">专家知识 · expert.db（决策级 · 人审定才进库）</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <input
            className="d-search"
            placeholder="搜索关键词…（expert search 语义，回车查询）"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void search();
            }}
          />
          <button className="btn" onClick={() => void search()}>搜索</button>
          <button className="btn" onClick={() => setImportOpen(true)}>导入 JSON/YAML</button>
        </div>
        {entries.length === 0 && <StateHint kind="empty" text="无匹配条目" hint="可导入或等 agent 起草" />}
        {entries.map((e) => (
          <div className="set-row" key={e.id}>
            <div>
              <div className="sr-label">{e.title}</div>
              <div className="sr-desc">
                {e.domain} · {e.kind} · 审定：{e.reviewer ?? '—'}
              </div>
            </div>
            <div className="sr-control">
              <button
                className="btn small"
                onClick={async () => {
                  const c = getSettingsClient();
                  if (!c) return;
                  const res = await api.expertShow(c, e.id);
                  setDetail(res.success ? ((res.data?.entry ?? null) as Record<string, unknown> | null) : null);
                }}
              >
                查看
              </button>
            </div>
          </div>
        ))}
        {detail && (
          <div className="ex-detail">
            <div className="ex-head">
              <span>{String(detail.title ?? '')}</span>
              <button className="btn small" onClick={() => setDetail(null)}>收起</button>
            </div>
            <pre className="ex-content">{String(detail.content ?? '')}</pre>
          </div>
        )}
      </div>
      <div className="set-group">
        <div className="sg-title">草稿</div>
        <div className="set-row">
          <div>
            <div className="sr-label">待审草稿</div>
            <div className="sr-desc">agent 起草 · 需你审定后才生效</div>
          </div>
          <div className="sr-control">
            <span className="sr-status">{drafts.length} 条待审</span>
          </div>
        </div>
        {drafts.map((d) => (
          <div className="set-row" key={d.id}>
            <div>
              <div className="sr-label">{d.title}</div>
              <div className="sr-desc">
                #{d.id} · {d.domain} · {d.kind}
              </div>
            </div>
            <div className="sr-control">
              <button
                className="btn small"
                onClick={async () => {
                  const c = getSettingsClient();
                  if (!c) return;
                  const res = await api.expertReview(c, { draftId: d.id, action: 'approve' });
                  showToast(res.success ? `✓ 草稿 #${d.id} 已批准入库` : `✗ ${res.error ?? '审定失败'}`);
                  void reloadDrafts();
                  void reloadList();
                }}
              >
                批准
              </button>
              <button
                className="btn small"
                onClick={async () => {
                  const c = getSettingsClient();
                  if (!c) return;
                  const res = await api.expertReview(c, { draftId: d.id, action: 'discard' });
                  showToast(res.success ? `已丢弃草稿 #${d.id}` : `✗ ${res.error ?? '丢弃失败'}`);
                  void reloadDrafts();
                }}
              >
                丢弃
              </button>
            </div>
          </div>
        ))}
      </div>
      {importOpen && (
        <ExpertImportModal
          onClose={() => setImportOpen(false)}
          onDone={(imported) => {
            setImportOpen(false);
            void reloadList();
            if (imported) void reloadDrafts();
          }}
        />
      )}
    </>
  );
}

function ExpertImportModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (imported: boolean) => void;
}): React.JSX.Element {
  const [raw, setRaw] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [pasteMode, setPasteMode] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const submitExpertImport = useGuiStore((s) => s.submitExpertImport);

  // 1.3.6：文件内容读取统一走 HTML input + FileReader（Tauri webview 的
  // WebView2 原生支持文件选择；tauri-plugin-fs 不在本次范围，dialog 只能
  // 拿路径拿不到内容，故 expert 不做 dialog 通道——浏览器与 Tauri 同一条
  // 通道，行为一致）。
  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // 允许重复选择同一文件
    if (!file) return;
    setFileName(file.name);
    setMsg('');
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') setRaw(reader.result);
      else setMsg('读取文件失败（非文本内容）');
    };
    reader.onerror = () => setMsg('读取文件失败');
    reader.readAsText(file);
  };

  return (
    <div className="modal-backdrop open">
      <div className="modal" style={{ width: 'min(560px, 90vw)' }}>
        <div className="m-head">
          <span className="m-title">导入专家知识</span>
          <span className="m-sub">JSON / YAML 文件 · 单条或数组批量 · 逐条校验</span>
          <button className="m-close" onClick={onClose}>✕</button>
        </div>
        <div className="m-body">
          <div className="f-label">
            必填：title / kind(idea|technique|sop) / domain / applicability / content / criteria / reviewer
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <button className="btn" onClick={() => fileRef.current?.click()}>选择文件…</button>
            <span className="sr-desc" style={{ alignSelf: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {fileName ?? (raw ? '已载入内容' : '未选择文件（.json / .yaml / .yml）')}
            </span>
            <button
              className="btn small"
              style={{ marginLeft: 'auto' }}
              onClick={() => setPasteMode((v) => !v)}
            >
              {pasteMode ? '收起粘贴' : '或粘贴内容'}
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".json,.yaml,.yml,application/json,text/yaml"
            style={{ display: 'none' }}
            onChange={onFileChange}
          />
          {pasteMode && (
            <textarea
              className="f-input"
              rows={8}
              placeholder={'- title: 堆喷占位 size 经验\n  kind: technique\n  domain: binary\n  applicability: glibc 2.3x 堆题\n  content: 做法正文……\n  criteria: 判定条件\n  reviewer: 你的名字'}
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
            />
          )}
          {msg && <div className="m-note">{msg}</div>}
          <div className="m-actions">
            <button className="btn" onClick={onClose}>取消</button>
            <button
              className="btn primary"
              disabled={busy || !raw.trim()}
              onClick={async () => {
                setBusy(true);
                const res = await submitExpertImport(raw);
                setMsg(res.message);
                setBusy(false);
                if (res.ok) {
                  setRaw('');
                  setFileName(null);
                  onDone(true);
                }
              }}
            >
              导入
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 研究记录页签 ──────────────────────────────────────────────────────

function ResearchTab(): React.JSX.Element {
  const [rows, setRows] = useState<ResearchEventRow[]>([]);

  useEffect(() => {
    const c = getSettingsClient();
    if (!c) return;
    void api.researchList(c).then(setRows).catch(() => {});
  }, []);

  return (
    <div className="set-group">
      <div className="sg-title">研究留痕 · research_events</div>
      {rows.length === 0 && <StateHint kind="empty" text="暂无研究事件" />}
      {rows.map((r) => (
        <div className="set-row" key={r.id ?? r.createdAt}>
          <div>
            <div className="sr-label">
              {r.outcome === 'success' ? '✔' : r.outcome === 'failure' || r.outcome === 'failed' ? '✗' : '○'} [{r.taskKind ?? '?'}] {r.summary ?? ''}
            </div>
            <div className="sr-desc">
              {r.bugClass ? `${r.bugClass} · ` : ''}
              {r.createdAt ?? ''}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── 外观页签（1.3.2 ③：深浅色切换，localStorage 持久化） ──────────────

function AppearanceTab(): React.JSX.Element {
  const theme = useGuiStore((s) => s.theme);
  const setTheme = useGuiStore((s) => s.setTheme);

  return (
    <div className="set-group">
      <div className="sg-title">主题</div>
      <div className="set-row">
        <div>
          <div className="sr-label">深色</div>
          <div className="sr-desc">默认 · 长时间研究注视友好</div>
        </div>
        <div className="sr-control">
          <span className={`sr-status ${theme === 'dark' ? 'ok' : ''}`}>
            {theme === 'dark' ? '✓ 当前' : ''}
          </span>
          <button className="btn small" onClick={() => setTheme('dark')}>应用</button>
        </div>
      </div>
      <div className="set-row">
        <div>
          <div className="sr-label">浅色</div>
          <div className="sr-desc">明亮环境使用（body.light 变量组 · 本地持久化）</div>
        </div>
        <div className="sr-control">
          <span className={`sr-status ${theme === 'light' ? 'ok' : ''}`}>
            {theme === 'light' ? '✓ 当前' : ''}
          </span>
          <button className="btn small" onClick={() => setTheme('light')}>应用</button>
        </div>
      </div>
    </div>
  );
}

// ── 页面装配 ──────────────────────────────────────────────────────────

export function SettingsPage(): React.JSX.Element {
  const [pg, setPg] = useState<string>('model');
  const setPage = useGuiStore((s) => s.setPage);

  return (
    <div className="settings-page show">
      <div className="settings-head">
        <button className="sh-close" onClick={() => setPage('chat')}>✕</button>
      </div>
      <div className="set-main">
        <div className="set-nav">
          {NAV.map((n) => (
            <div
              className={`set-nav-item ${pg === n.id ? 'on' : ''} ${n.disabled ? 'disabled' : ''}`}
              key={n.id}
              title={n.disabled ? '设计待定——后续版本启用' : undefined}
              onClick={() => {
                if (!n.disabled) setPg(n.id);
              }}
            >
              <span className="sn-ic">{n.icon}</span>
              {n.label}
            </div>
          ))}
        </div>
        <div className="set-content">
          {pg === 'model' && <ModelTab />}
          {pg === 'intel' && <IntelTab />}
          {pg === 'expert' && <ExpertTab />}
          {pg === 'research' && <ResearchTab />}
          {pg === 'appearance' && <AppearanceTab />}
          {pg === 'about' && (
            <div className="set-group">
              <div className="sg-title">zhishi · 执失</div>
              <div className="set-row">
                <div><div className="sr-label">版本</div></div>
                <div className="sr-control"><span className="sr-status">v{GUI_VERSION} GUI</span></div>
              </div>
              <div className="set-row">
                <div><div className="sr-label">数据目录</div></div>
                <div className="sr-control"><span className="sr-status mono">~/.zhishi</span></div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
