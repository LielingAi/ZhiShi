/**
 * 情报配置（1.3.6）：IntelTab 的纯函数层——config-update payload 构造 +
 * 三个模式的中文标签/说明。
 *
 * 语义以服务端实现为准（不编）：
 *   - window = 时间窗口：sync.ts 只拉取/保留最近 windowYears 年发布的
 *     CVE（写入过滤 + pruneWindow 开启时的存量裁剪）；exploit-db/nuclei
 *     仍全量替换。1.3.6 起存量裁剪只在「配置已提交 window」时执行
 *     （handleIntelUpdate 传 pruneWindow），一次性档位覆盖不删历史。
 *   - minimal 与 full：当前实现行为一致——都全量回填（1988 起）+ 按
 *     maxSizeMb 兜底裁剪；1.1.2 设计文档的「minimal 只存核心字段」未在
 *     sync 层落地（无字段级裁剪代码）。
 *   - 三个模式在注入/提示侧无差异：mode 只落 intel.db 的 meta.mode
 *     （状态展示），intel_search 的在线回源只读 onlineFallback，不读 mode。
 */

export type IntelMode = 'minimal' | 'window' | 'full';

/** 服务端 INTEL_DEFAULTS.mode（config-types.ts）——GUI 侧本地镜像，勿跨包 import。 */
export const INTEL_MODE_DEFAULT: IntelMode = 'minimal';

export const INTEL_MODES: readonly IntelMode[] = ['minimal', 'window', 'full'];

export interface IntelModeMeta {
  label: string;
  desc: string;
}

export const INTEL_MODE_META: Record<IntelMode, IntelModeMeta> = {
  minimal: {
    label: '精简',
    desc: '全量拉取 NVD（1988 起）+ exploit-db + nuclei，仅按大小上限兜底裁剪。当前与「全量」行为一致（最小化存储的设计未在 sync 层落地）。',
  },
  window: {
    label: '时间窗口',
    desc: '只拉取/保留最近 windowYears 年（默认 3）发布的 CVE；配置提交后更新末尾会删除窗口外的历史 CVE（含无发布日期记录）。exploit-db / nuclei 仍全量。',
  },
  full: {
    label: '全量',
    desc: '全量拉取 NVD（1988 起）+ exploit-db + nuclei，仅按大小上限兜底裁剪。',
  },
};

/** intel/status 返回的合并配置（resolveIntelConfig 形状）。 */
export interface IntelResolvedConfig {
  mode: IntelMode;
  windowYears: number;
  maxSizeMb: number;
  onlineFallback: boolean;
}

/** 配置编辑表单（窗口年数/大小上限用字符串承载输入态）。 */
export interface IntelConfigForm {
  mode: IntelMode;
  windowYears: string;
  maxSizeMb: string;
  onlineFallback: boolean;
}

export type IntelConfigPatchResult =
  | { ok: true; patch: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * 表单 → intel/config-update 补丁（PATCH 语义：只传被改字段）。
 * resolved 为 null（intel/status 未取到）时按服务端缺省值作 diff 基线
 * （mode='minimal'，而非旧的 'window'——1.3.6 修正的丢数据诱因之一）。
 * 非法值返回 error（不产出部分补丁——与旧行为一致：整次保存中止）。
 */
export function buildIntelConfigPatch(
  form: IntelConfigForm,
  resolved: IntelResolvedConfig | null,
): IntelConfigPatchResult {
  const patch: Record<string, unknown> = {};
  if (form.mode !== (resolved?.mode ?? INTEL_MODE_DEFAULT)) patch.mode = form.mode;

  if (form.windowYears.trim() !== '') {
    const wy = Number(form.windowYears);
    if (!Number.isFinite(wy) || wy <= 0) return { ok: false, error: 'windowYears 需为正数（年）' };
    if (wy !== resolved?.windowYears) patch.windowYears = wy;
  }

  if (form.maxSizeMb.trim() !== '') {
    const mb = Number(form.maxSizeMb);
    if (!Number.isFinite(mb) || mb <= 0) return { ok: false, error: 'maxSizeMb 需为正数（MB）' };
    if (mb !== resolved?.maxSizeMb) patch.maxSizeMb = mb;
  }

  if (form.onlineFallback !== (resolved?.onlineFallback ?? true)) {
    patch.onlineFallback = form.onlineFallback;
  }
  return { ok: true, patch };
}
