/**
 * 1.3.3 @ 补全纯函数层：触发解析 + 多数据源清单装配（环境 / 文件 /
 * 子代理 / 工具）。
 *
 * 触发语义（与 InputArea 的 @ 正则同口径）：
 *   - `@xxx`            → 环境 / 子代理 / 工具（不含 '/',不触发文件树）
 *   - `@dir/…`          → 文件目录前缀触发：dir 前缀走 /api/workspace/files，
 *                          按 '/' 后片段过滤文件名
 * 选中文案分两类：
 *   - env / file → chips ref（model/send.ts 的 Ref，服务端解析 grounding）
 *   - agent / tool / dir → 纯文本插入（替换输入框尾部 @token）
 *
 * 纯函数：不 import store / React / client；单测覆盖触发解析与清单装配。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type MentionKind = 'env' | 'file' | 'agent' | 'tool';

export interface MentionItem {
  kind: MentionKind;
  /** 列表展示名（env 条目 id / 文件相对路径 / 子代理名 / 工具名）。 */
  label: string;
  detail?: string;
  /** env ref（kind=env）：{type:'env', id}。 */
  id?: string;
  /** file ref（kind=file）：工作区相对路径（POSIX 正斜杠）。 */
  path?: string;
  /** 选中后替换输入框尾部 @token 的纯文本（agent/tool/目录续触发）。 */
  insert?: string;
  /** 分节标题（环境 / 文件 / 子代理 / 工具）。 */
  section: string;
}

/** @ 触发解析结果。 */
export interface MentionQuery {
  /** @ 后的原始查询串（可能含 '/'）。 */
  query: string;
  /** 文件目录前缀（含 '/' 时为非 null；'' = 工作区根）。 */
  dir: string | null;
  /** '/' 后的文件名片段（无 '/' 时为整个查询）。 */
  name: string;
  /** true = 目录前缀触发（走 workspace/files 数据源）。 */
  isFileDir: boolean;
}

export interface MentionSources {
  envs: Array<{ id: string; kind?: string }>;
  agents: Array<{ name: string; description?: string; scope?: string }>;
  tools: string[];
  files: Array<{ path: string; type: 'file' | 'dir' | 'symlink' }>;
}

// ---------------------------------------------------------------------------
// 触发解析 / 工具
// ---------------------------------------------------------------------------

/** 路径末段（跨平台纯字符串实现——浏览器构建不引 node:path）。 */
export function pathBasename(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? p.slice(idx + 1) : p;
}

/**
 * @ 后查询串 → 触发解析。`@src/` → {dir:'src', name:''}（列目录）；
 * `@src/ma` → {dir:'src', name:'ma'}（前缀过滤）；`@envname` → 普通触发。
 */
export function parseMentionQuery(rawQuery: string): MentionQuery {
  const query = (rawQuery ?? '').replace(/^\s+/, '');
  const idx = query.lastIndexOf('/');
  if (idx >= 0) {
    return { query, dir: query.slice(0, idx), name: query.slice(idx + 1), isFileDir: true };
  }
  return { query, dir: null, name: query, isFileDir: false };
}

// ---------------------------------------------------------------------------
// 清单装配
// ---------------------------------------------------------------------------

const SECTIONS: Record<MentionKind, string> = {
  env: '环境',
  file: '文件',
  agent: '子代理',
  tool: '工具',
};

/**
 * 四源合一 → 分节补全项。文件树只在目录前缀触发（isFileDir）时并入；
 * 其余时刻只出环境/子代理/工具。所有源按 name 片段不区分大小写过滤。
 */
export function buildMentionItems(q: MentionQuery, src: MentionSources): MentionItem[] {
  const items: MentionItem[] = [];
  const match = (label: string): boolean => {
    const n = q.name.trim().toLowerCase();
    if (!n) return true;
    return label.toLowerCase().includes(n);
  };

  if (!q.isFileDir) {
    for (const e of src.envs) {
      if (!match(e.id)) continue;
      items.push({
        kind: 'env',
        label: e.id,
        detail: `${e.kind ?? '环境'} · 环境引用`,
        id: e.id,
        section: SECTIONS.env,
      });
    }
    for (const a of src.agents) {
      if (!match(a.name)) continue;
      items.push({
        kind: 'agent',
        label: a.name,
        detail: a.description ?? (a.scope === 'project' ? '项目子代理' : '子代理'),
        insert: a.name,
        section: SECTIONS.agent,
      });
    }
    for (const t of src.tools) {
      if (!match(t)) continue;
      items.push({ kind: 'tool', label: t, detail: '工具', insert: t, section: SECTIONS.tool });
    }
    return items;
  }

  // 文件树只在目录前缀触发（isFileDir）时并入；dir 前缀防御性再过滤一道
  // （调用方按 dir 拉取是常态，这里保证「只列该目录下」的契约不依赖它）。
  const dirPrefix = q.dir ? `${q.dir.replace(/\/+$/, '')}/` : '';
  for (const f of src.files) {
    if (dirPrefix && !f.path.startsWith(dirPrefix)) continue;
    if (!match(pathBasename(f.path))) continue;
    const isDir = f.type === 'dir';
    items.push({
      kind: 'file',
      label: isDir ? `${f.path}/` : f.path,
      detail: isDir ? '目录' : f.type === 'symlink' ? '链接' : '文件',
      ...(isDir ? { insert: `@${f.path}/` } : { path: f.path }),
      section: SECTIONS.file,
    });
  }
  return items;
}

/** 文件数据源的目录前缀（workspace/files 的 dir 参数）。 */
export function fileDirOf(q: MentionQuery): string {
  return q.isFileDir ? (q.dir ?? '') : '';
}
