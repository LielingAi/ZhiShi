/**
 * 1.4.10 #6 — 自定义供应商（中转站）表单的纯模型层。
 *
 * buildCustomProviderPayload：表单输入 → model/add 的 provider payload。
 * 校验口径与服务端 handleModelAdd 对齐（id 字符集 / baseUrl / 至少一个模型），
 * 错误在本地先说清，不打冤枉的请求。零 IO——组件薄壳化。
 */

export interface CustomProviderForm {
  id: string;
  name: string;
  baseUrl: string;
  /** openai（中转站典型）/ anthropic。 */
  protocol: 'openai' | 'anthropic';
  /** 模型 ID 列表（逗号/换行/空格分隔的原始输入）。 */
  modelsRaw: string;
  /** 主模型（缺省 = 模型列表首个）。 */
  primaryModel: string;
}

export type CustomProviderValidation =
  | { ok: true; provider: Record<string, unknown> }
  | { ok: false; error: string };

/** id 字符集与服务端 isValidId 同口径（英数字符 + 连字符 + 下划线）。 */
const ID_RE = /^[A-Za-z0-9_-]+$/;

/** 模型 ID 原始输入 → 列表（逗号/换行/空白分隔，去重保序）。 */
export function parseModelIds(raw: string): string[] {
  const out: string[] = [];
  for (const token of raw.split(/[\s,，、]+/)) {
    const t = token.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

export function buildCustomProviderPayload(form: CustomProviderForm): CustomProviderValidation {
  const id = form.id.trim();
  if (!id) return { ok: false, error: '需要 id（英文标识，如 my-relay）' };
  if (!ID_RE.test(id)) return { ok: false, error: 'id 只允许英数字符、连字符和下划线' };
  const name = form.name.trim();
  if (!name) return { ok: false, error: '需要名称（展示用，如「XX 中转站」）' };
  const baseUrl = form.baseUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/.+/.test(baseUrl)) {
    return { ok: false, error: 'baseUrl 需要是 http(s) 端点（中转站典型形态如 https://relay.example.com/v1）' };
  }
  const models = parseModelIds(form.modelsRaw);
  if (models.length === 0) return { ok: false, error: '至少一个模型 ID（中转站后台可查，如 gpt-4o / claude-sonnet-4-5）' };
  const primaryModel = form.primaryModel.trim() || models[0];
  if (!models.includes(primaryModel)) {
    return { ok: false, error: `主模型 ${primaryModel} 不在模型列表里` };
  }
  return {
    ok: true,
    provider: {
      id,
      name,
      vendor: name,
      baseUrl,
      protocol: form.protocol,
      models,
      primaryModel,
      // 中转站典型认证：Authorization Bearer（与服务端缺省 auth_token 一致）。
      authType: 'auth_token',
    },
  };
}
