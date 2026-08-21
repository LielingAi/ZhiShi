# bundled-expert —— 内置专家知识（发行载体）

1.2.1 专家知识层（骨架期）的内置条目目录。文件是**发行载体不是存储**——
sidecar 启动时按 content_hash 幂等导入/更新 `~/.zhishi/expert.db`
（`src/server/expert/seed.ts`），DB 是唯一事实源。

## 布局

```
bundled-expert/<domain>/<slug>.md
```

- `<domain>` ∈ RESEARCH_TASK_KINDS 闭集（binary / pentest / ai-security /
  redteam / malware / whitebox / intel / ctf），取目录名。
- `<slug>` 小写短横线；条目身份跟 `<domain>/<slug>` 走（改标题也能正确覆盖）。

## 文件格式

frontmatter（YAML）+ markdown 正文：

```markdown
---
kind: technique          # idea | technique | sop
title: 一句话标题
applicability: 什么时候该用它
criteria: 怎么验证用对了
tags: 逗号,分隔,标签     # 可空
---

正文 = 条目的 content（markdown 自由结构）。
```

- provenance 恒为 builtin（seed 强制，文件里不写）。
- 内置条目更新 = 强制覆盖库内同来源条目；user/promoted 条目 seed 绝不动。
- 所有字段过 `validateEntry()` 单点校验（src/server/expert/validate.ts）。
