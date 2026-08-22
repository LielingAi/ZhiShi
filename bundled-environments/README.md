# bundled-environments

安全研究员版「环境类型」（environment recipe）的随包目录（P1 E4）。我们不向用户分发工具，
而是分发「能把干净环境变成可用研究环境」的环境类型。

## 配方目录结构

```
bundled-environments/<name>/
  Dockerfile    # 基础镜像 + 工具集 + 服务（docker 配方必需）
  setup.sh      # 初始化：装依赖、部署目标、起服务、自检
  SKILL.md      # frontmatter: name / description / base(docker|vm) / tools[]
                # 正文教方法：何时用、怎么进、结果怎么采、怎么收尾
```

- `tools[]` 是发现环节能力清单注入的**唯一事实源**（不解析 Dockerfile）。
- VM 配方（`base: vm`）= SKILL.md（frontmatter 可带 `vm_base` / `vm_user` /
  `vm_snapshot`）+ 初始化脚本 + 快照约定；up 生命周期由
  `src/server/environment/vm-lifecycle.ts`（vmrun 驱动）提供，D22 直连真实
  VM（不拷贝派生——vmTemplates 条目就是环境本身）：已在跑则幂等刷新地址；
  否则声明快照存在则 revert → `vmrun start nogui` →
  `getGuestIPAddress -wait` 拿地址并回写 env 条目（`env open` 走 SSH）。
  VM 来源（解析顺序）：`env up --vm-base` 现场给 > `zhishi env adopt`
  养成后落 config.json::vmTemplates（自动供应 + 快照，推荐）>
  frontmatter `vm_base`。
- 打包时本目录经 `src-tauri/tauri.conf.json` resources 映射进应用资源，
  Rust 侧 `cmd_seed_environment_recipes`（`src-tauri/src/commands.rs`）按
  **seed-if-missing** 策略落盘到 `~/.zhishi/environments/`（首轮播种/自愈
  缺失）；在此之上 Node 侧 `syncEnvironmentRecipes`
  （`src/server/skills-config.ts`）做**内容哈希同步**（1.2.5「配」）——
  内容一致 no-op；bundled 配方有修正则覆盖落盘，旧版整个备份到
  `<配方>.bak-<YYYYMMDD>`（用户/LLM 的本地迭代可从此回滚）。
  `ENVIRONMENT_RECIPES_VERSION` bump 触发 Rust 侧新一轮播种（只补缺失
  配方）；内容修正在 server 启动时由 Node 侧同步触达老安装。

具体配方由 E5 任务补充；新增配方 = 在此建目录 + bump
`ENVIRONMENT_RECIPES_VERSION`。
