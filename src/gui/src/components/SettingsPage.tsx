/**
 * 设置页（1.3.1 ⑥）：页签接真——
 *   模型     model/list + model/set-key（隐藏输入模态）+ set-default + verify
 *   Skills   skill/list + skill/enable|disable + /api/skill/import-folder
 *   MCP      1.3.5：mcp/list + mcp/list-status + mcp/enable|disable + mcp/reload
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

import { useCallback, useEffect, useState } from 'react';
import type React from 'react';

import { getSettingsClient, useGuiStore } from '../store/useGuiStore';
import * as api from '../client/api';
import type { ExpertDraft, ExpertSummary, ModelProvider, ResearchEventRow, SkillEntity } from '../client/api';
import { composeMcpRows, type McpDisplayRow } from '../model/mcp';
import { StateHint } from './StateHint';

const NAV = [
  { id: 'model', icon: '◇', label: '模型' },
  { id: 'skills', icon: '▤', label: 'Skills' },
  { id: 'mcp', icon: '⇄', label: 'MCP' },
  { id: 'intel', icon: '◈', label: '情报' },
  { id: 'expert', icon: '◇', label: '专家知识' },
  { id: 'research', icon: '✎', label: '研究记录' },
  { id: 'appearance', icon: '◐', label: '外观' },
  { id: 'about', icon: 'ⓘ', label: '关于' },
] as const;

// ── 模型页签 ──────────────────────────────────────────────────────────

function ModelTab(): React.JSX.Element {
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [current, setCurrent] = useState<{ providerId?: string; modelId?: string } | null>(null);
  const [keyProvider, setKeyProvider] = useState<string | null>(null);
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
              <div className="sr-label">{p.id}</div>
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
            </div>
          </div>
        ))}
      </div>
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

// ── Skills 页签 ───────────────────────────────────────────────────────

function SkillsTab(): React.JSX.Element {
  const [skills, setSkills] = useState<SkillEntity[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const showToast = useGuiStore((s) => s.showToast);

  const reload = useCallback(async () => {
    const c = getSettingsClient();
    if (!c) return;
    try {
      setSkills(await api.fetchSkillList(c));
    } catch {
      // 静默。
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div className="set-group">
      <div className="sg-title">用户级技能 · ~/.zhishi/skills/</div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <span className="sr-desc" style={{ alignSelf: 'center' }}>
          共 {skills.length} 个 · skill enable/disable 即时生效
        </span>
        <button className="btn small" style={{ marginLeft: 'auto' }} onClick={() => setImportOpen(true)}>
          导入技能
        </button>
      </div>
      {skills.length === 0 && <StateHint kind="empty" text="无用户级技能" hint="未连接 sidecar 或 ~/.zhishi/skills/ 为空" />}
      {skills.map((sk) => (
        <div className="set-row" key={sk.folderName ?? sk.name}>
          <div>
            <div className="sr-label">{sk.name}</div>
            <div className="sr-desc">{sk.description}</div>
          </div>
          <div className="sr-control">
            <span className={`sr-status ${sk.enabled ? 'ok' : ''}`}>{sk.enabled ? '启用' : '禁用'}</span>
            <button
              className="btn small"
              onClick={async () => {
                const c = getSettingsClient();
                if (!c) return;
                const res = await api.skillToggle(c, sk.folderName ?? sk.name, !sk.enabled);
                showToast(res.success ? `✓ ${sk.name} 已${res.data?.enabled === false ? '禁用' : '启用'}` : `失败：${res.error ?? '未知错误'}`);
                void reload();
              }}
            >
              {sk.enabled ? '禁用' : '启用'}
            </button>
          </div>
        </div>
      ))}
      {importOpen && <SkillImportModal onClose={() => setImportOpen(false)} onDone={() => { setImportOpen(false); void reload(); }} />}
    </div>
  );
}

function SkillImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }): React.JSX.Element {
  const [path, setPath] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const showToast = useGuiStore((s) => s.showToast);

  return (
    <div className="modal-backdrop open">
      <div className="modal" style={{ width: 'min(460px, 90vw)' }}>
        <div className="m-head">
          <span className="m-title">导入技能</span>
          <span className="m-sub">目录需含 SKILL.md（frontmatter 声明 name/description）</span>
          <button className="m-close" onClick={onClose}>✕</button>
        </div>
        <div className="m-body">
          <div className="f-label">技能目录路径（/api/skill/import-folder）</div>
          <input
            className="f-input"
            placeholder="D:\skills\my-recon"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy) void doImport();
            }}
          />
          {err && <div className="m-error">✗ {err}</div>}
          <div className="m-actions">
            <button className="btn" onClick={onClose}>取消</button>
            <button className="btn primary" disabled={busy} onClick={() => void doImport()}>导入</button>
          </div>
        </div>
      </div>
    </div>
  );

  async function doImport() {
    if (!path.trim()) {
      setErr('目录路径为空');
      return;
    }
    setBusy(true);
    try {
      const c = getSettingsClient();
      if (!c) {
        setErr('未连接 sidecar');
        return;
      }
      const res = await api.skillImportFolder(c, path.trim());
      if (!res.success) {
        setErr(res.error ?? '导入失败');
        return;
      }
      showToast('✓ 技能已导入');
      onDone();
    } finally {
      setBusy(false);
    }
  }
}

// ── MCP 页签（1.3.5：list/状态/启停/热重载） ────────────────────────────

/** 状态列文案（composeMcpRows 的 status → 中文）。 */
function mcpStatusText(row: McpDisplayRow): string {
  switch (row.status) {
    case 'connected':
      return `connected${typeof row.toolCount === 'number' ? ` · ${row.toolCount} 工具` : ''}`;
    case 'failed':
      return `failed · ${row.error ?? '未知错误'}`;
    case 'off':
      return '已停用';
    case 'unknown':
      return '已启用 · 未连接';
  }
}

function McpTab(): React.JSX.Element {
  const [rows, setRows] = useState<McpDisplayRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const showToast = useGuiStore((s) => s.showToast);

  const reload = useCallback(async () => {
    const c = getSettingsClient();
    if (!c) {
      setRows(null);
      setError('未连接 sidecar');
      return;
    }
    setError(null);
    try {
      // 清单拉不到（含未连接）→ error 态；桥状态失败降级为全 unknown。
      const [servers, statuses] = await Promise.all([
        api.fetchMcpList(c).catch(() => null),
        api.fetchMcpStatus(c).catch(() => null),
      ]);
      if (servers === null) {
        setRows(null);
        setError('mcp/list 拉取失败');
        return;
      }
      setRows(composeMcpRows(servers, statuses ?? []).rows);
    } catch {
      setRows(null);
      setError('MCP 状态获取失败');
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 启停开关：写盘（mcp/enable|disable）→ 桥热重载 → 刷状态（TUI /mcp 同序）。 */
  const toggle = async (row: McpDisplayRow) => {
    const c = getSettingsClient();
    if (!c) return;
    setBusy(true);
    try {
      const res = await api.mcpToggle(c, row.id, !row.enabled);
      if (!res.success) {
        showToast(`✗ ${row.enabled ? '停用' : '启用'}失败：${res.error ?? '未知错误'}`);
        return;
      }
      const reloadRes = await api.mcpReload(c);
      if (!reloadRes.success) {
        showToast(`配置已写入但桥重载失败：${reloadRes.error ?? '未知错误'}`);
      }
      await reload();
      showToast(`✓ 已${row.enabled ? '停用' : '启用'} ${row.id}`);
    } finally {
      setBusy(false);
    }
  };

  const reloadBridge = async () => {
    const c = getSettingsClient();
    if (!c) return;
    setBusy(true);
    try {
      const res = await api.mcpReload(c);
      if (!res.success) {
        showToast(`✗ 热重载失败：${res.error ?? '未知错误'}`);
        return;
      }
      await reload();
      showToast('✓ MCP 桥已热重载（重读磁盘配置 → 重连）');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="set-group">
      <div className="sg-title">MCP 工具服务器 · config.json</div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <span className="sr-desc" style={{ alignSelf: 'center' }}>
          {rows === null ? '' : `${rows.length} 台 · 启停写盘即时生效（桥热重载）`}
        </span>
        <button className="btn small" style={{ marginLeft: 'auto' }} disabled={busy} onClick={() => void reloadBridge()}>
          {busy ? '重载中…' : '⟳ 热重载'}
        </button>
      </div>
      {rows === null && error === null && <StateHint kind="loading" text="加载 MCP 状态…" />}
      {rows === null && error !== null && (
        <StateHint kind="error" text={error} hint="确认 sidecar 已连接后点「热重载」重试" />
      )}
      {rows !== null && rows.length === 0 && (
        <StateHint kind="empty" text="无 MCP 服务器" hint="在 ~/.zhishi/config.json 配置 mcpServers 或通过 zhishi mcp add 添加" />
      )}
      {rows !== null &&
        rows.map((r) => (
          <div className="set-row" key={r.id}>
            <div>
              <div className="sr-label">{r.id}</div>
              <div className="sr-desc">
                {r.source === 'builtin' ? '内置' : '自定义'}
                {r.type ? ` · ${r.type}` : ''}
                {r.name !== r.id ? ` · ${r.name}` : ''}
              </div>
            </div>
            <div className="sr-control">
              <span className={`sr-status ${r.status === 'connected' ? 'ok' : r.status === 'failed' ? 'bad' : ''}`}>
                {mcpStatusText(r)}
              </span>
              <button className="btn small" disabled={busy} onClick={() => void toggle(r)}>
                {r.enabled ? '停用' : '启用'}
              </button>
            </div>
          </div>
        ))}
    </div>
  );
}

// ── 情报页签 ──────────────────────────────────────────────────────────

function IntelTab(): React.JSX.Element {
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [mode, setMode] = useState<string>('window');
  const [busy, setBusy] = useState(false);
  // 1.3.2 任务二 #4：配置编辑表单（intel/config-update 部分更新）。
  const [cfgForm, setCfgForm] = useState<{ mode: string; windowYears: string; maxSizeMb: string; onlineFallback: boolean }>({
    mode: 'window',
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
      setConfig(data.config ?? null);
      const cfgMode = typeof data.config?.mode === 'string' ? data.config.mode : 'window';
      setMode(cfgMode);
      setCfgForm({
        mode: cfgMode,
        windowYears: data.config?.windowYears !== undefined ? String(data.config.windowYears) : '',
        maxSizeMb: data.config?.maxSizeMb !== undefined ? String(data.config.maxSizeMb) : '',
        onlineFallback: data.config?.onlineFallback !== false,
      });
    } catch {
      // 静默。
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 配置部分更新：diff 出被改字段 → intel/config-update（只传改动）。 */
  const saveConfig = async () => {
    const c = getSettingsClient();
    if (!c) return;
    const patch: Record<string, unknown> = {};
    if (cfgForm.mode !== String(config?.mode ?? 'window')) patch.mode = cfgForm.mode;
    const wy = Number(cfgForm.windowYears);
    if (cfgForm.windowYears !== '' && (!Number.isFinite(wy) || wy <= 0)) {
      showToast('✗ windowYears 需为正数（年）');
      return;
    }
    if (cfgForm.windowYears !== '' && wy !== config?.windowYears) patch.windowYears = wy;
    const mb = Number(cfgForm.maxSizeMb);
    if (cfgForm.maxSizeMb !== '' && (!Number.isFinite(mb) || mb <= 0)) {
      showToast('✗ maxSizeMb 需为正数（MB）');
      return;
    }
    if (cfgForm.maxSizeMb !== '' && mb !== config?.maxSizeMb) patch.maxSizeMb = mb;
    if (cfgForm.onlineFallback !== (config?.onlineFallback !== false)) patch.onlineFallback = cfgForm.onlineFallback;
    if (Object.keys(patch).length === 0) {
      showToast('配置无变更');
      return;
    }
    setSavingCfg(true);
    try {
      const res = await api.intelConfigUpdate(c, patch);
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
            {['minimal', 'window', 'full'].map((m) => (
              <button
                className={`btn small ${mode === m ? 'mode-on' : ''}`}
                key={m}
                onClick={() => setMode(m)}
              >
                {m}
              </button>
            ))}
            <button
              className="btn small primary"
              disabled={busy}
              onClick={async () => {
                const c = getSettingsClient();
                if (!c) return;
                setBusy(true);
                showToast(`⏳ 更新情报索引（${mode}）…`);
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
      </div>
      <div className="set-group">
        <div className="sg-title">配置 · intel（部分更新 → intel/config-update）</div>
        <div className="set-row">
          <div><div className="sr-label">存储分级</div></div>
          <div className="sr-control">
            {['minimal', 'window', 'full'].map((m) => (
              <button
                className={`btn small ${cfgForm.mode === m ? 'mode-on' : ''}`}
                key={m}
                onClick={() => setCfgForm((f) => ({ ...f, mode: m }))}
              >
                {m}
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
              placeholder={String(config?.maxSizeMb ?? '512')}
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
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const submitExpertImport = useGuiStore((s) => s.submitExpertImport);

  return (
    <div className="modal-backdrop open">
      <div className="modal" style={{ width: 'min(560px, 90vw)' }}>
        <div className="m-head">
          <span className="m-title">导入专家知识</span>
          <span className="m-sub">JSON / YAML · 单条或数组批量 · 逐条校验</span>
          <button className="m-close" onClick={onClose}>✕</button>
        </div>
        <div className="m-body">
          <div className="f-label">
            必填：title / kind(idea|technique|sop) / domain / applicability / content / criteria / reviewer
          </div>
          <textarea
            className="f-input"
            rows={10}
            placeholder={'- title: 堆喷占位 size 经验\n  kind: technique\n  domain: binary\n  applicability: glibc 2.3x 堆题\n  content: 做法正文……\n  criteria: 判定条件\n  reviewer: 你的名字'}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
          />
          {msg && <div className="m-note">{msg}</div>}
          <div className="m-actions">
            <button className="btn" onClick={onClose}>取消</button>
            <button
              className="btn primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const res = await submitExpertImport(raw);
                setMsg(res.message);
                setBusy(false);
                if (res.ok) {
                  setRaw('');
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
              className={`set-nav-item ${pg === n.id ? 'on' : ''}`}
              key={n.id}
              onClick={() => setPg(n.id)}
            >
              <span className="sn-ic">{n.icon}</span>
              {n.label}
            </div>
          ))}
        </div>
        <div className="set-content">
          {pg === 'model' && <ModelTab />}
          {pg === 'skills' && <SkillsTab />}
          {pg === 'mcp' && <McpTab />}
          {pg === 'intel' && <IntelTab />}
          {pg === 'expert' && <ExpertTab />}
          {pg === 'research' && <ResearchTab />}
          {pg === 'appearance' && <AppearanceTab />}
          {pg === 'about' && (
            <div className="set-group">
              <div className="sg-title">zhishi · 执失</div>
              <div className="set-row">
                <div><div className="sr-label">版本</div></div>
                <div className="sr-control"><span className="sr-status">v1.3.1 GUI</span></div>
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
