# ZhiShi 脚本说明

本目录包含 ZhiShi 项目开发、构建、发布所需的全部脚本。脚本按生命周期分类存放：

| 目录 | 用途 |
|------|------|
| `setup/` | 环境初始化 |
| `dev/` | 开发调试 |
| `build/` | 生产构建 |
| `release/` | 发布与回滚 |
| 根目录 | 通用辅助脚本 |

所有脚本默认从项目根目录执行，例如：

```bash
./scripts/dev/start_dev.sh
```

---

## 环境初始化

### `scripts/setup/setup.sh`

**用途**：macOS / Linux 首次环境初始化。

**执行内容**：

- 检查 Node.js、npm、Rust、Cargo 是否安装
- 下载内置 Node.js v24.14.0
- 执行 `npm install`
- 重建 native addons
- 执行 `cargo check` / `cargo fetch`
- 校验默认工作区 `novo/` 并清理 `.git`

**用法**：

```bash
./scripts/setup/setup.sh
```

### `scripts/setup/setup_windows.ps1`

**用途**：Windows 首次环境初始化。

**执行内容**：

- 检查 Node.js、npm、Rust、Cargo 是否安装
- 下载内置 Node.js v24.14.0
- 下载 Git for Windows 安装包（供 NSIS 打包使用）
- 执行 `npm install`
- 重建 native addons
- 校验默认工作区 `novo/` 并清理 `.git`

**用法**：

```powershell
.\scripts\setup\setup_windows.ps1
```

---

## 开发调试

### `scripts/dev/start_dev.sh`

**用途**：启动浏览器开发模式。

**执行内容**：

- 使用内置 Node + `tsx/esm` + `--watch` 启动 Sidecar（端口 3000）
- 启动 Vite 前端开发服务器（端口 5173）
- 访问 `http://localhost:5173` 进行开发

**用法**：

```bash
./scripts/dev/start_dev.sh
```

### `scripts/dev/build_dev.sh`

**用途**：macOS / Linux Debug 桌面构建。

**特点**：

- 构建带 DevTools 的 `.app`
- 仅构建当前架构
- 适合本地调试桌面端

**用法**：

```bash
./scripts/dev/build_dev.sh
```

### `scripts/dev/build_dev_win.ps1`

**用途**：Windows Debug 桌面构建。

**特点**：

- 构建带 DevTools 的 exe
- 适合本地调试桌面端

**用法**：

```powershell
.\scripts\dev\build_dev_win.ps1
```

---

## 生产构建

### `scripts/build/build_macos.sh`

**用途**：macOS 生产构建。

**执行内容**：

- 版本同步检查
- TypeScript 检查
- 打包 server / bridge / cli
- 预装 sharp 图像运行时
- 签名 externalBin / vendor / sharp / tsx-runtime / Node.js / Claude SDK native binary
- 构建 ARM/Intel 架构的 DMG 和 tar.gz
- 验证签名与公证
- 可选发布到 R2

**产物**：

- `src-tauri/target/<triple>/release/bundle/dmg/*.dmg`
- `src-tauri/target/<triple>/release/bundle/macos/*.app.tar.gz`

**用法**：

```bash
./scripts/build/build_macos.sh
```

### `scripts/build/build_linux.sh`

**用途**：Linux 生产构建。

**产物**：

- AppImage
- deb 安装包

**用法**：

```bash
./scripts/build/build_linux.sh
```

### `scripts/build/build_windows.ps1`

**用途**：Windows 生产构建。

**产物**：

- NSIS 安装包
- 便携版 ZIP

**参数**：

- `-USBMode`：启用 USB 模式构建

**用法**：

```powershell
.\scripts\build\build_windows.ps1
```

### `scripts/build/sync-bundled-skills.cjs`

**用途**：将 `skillshub` 分类技能库同步到 `bundled-skills/`，使技能随安装包分发并在首次启动时自动 seed 到用户目录。

**执行内容**：

- 扫描 `SKILLHUB_DIR`（默认 `D:/project/skillshub/classified_top5`）下所有包含 `SKILL.md` 的目录
- 自动跳过 `node_modules`、隐藏目录等
- 为与现有官方 bundled skill 重名的技能生成 hash 后缀，避免冲突
- 维护 `bundled-skills/.skillshub-manifest.json`，支持重复同步时清理旧技能
- 将技能复制到 `bundled-skills/`，Tauri 打包时会自动纳入资源

**环境变量**：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `SKILLHUB_DIR` | skillhub 分类库根目录 | `D:/project/skillshub/classified_top5` |
| `BUNDLED_SKILLS_DIR` | 输出目录 | `./bundled-skills` |
| `DRY_RUN` | 设为 `1` 时只打印不复制 | 空 |

**用法**：

```bash
# 默认同步全部技能
npm run sync:bundled-skills

# 指定其它 skillhub 路径
SKILLHUB_DIR=/path/to/skillshub/classified_top5 npm run sync:bundled-skills

# 只预览会同步哪些技能
DRY_RUN=1 npm run sync:bundled-skills
```

**注意**：

- 同步后 `bundled-skills/` 会新增约 800 个文件夹、约 44MB。
- 全量打包会显著增加安装包体积和首次启动 seed 时间，建议只精选业务需要的技能。
- 官方 bundled skills（`agent-browser`、`docx`、`download-anything`、`pdf`、`pptx`、`skill-creator`、`task-alignment`、`task-implement`、`xlsx`、`zhishi-cli`）不会被覆盖。
- 清理已同步的技能：

```bash
CLEAN_ONLY=1 npm run sync:bundled-skills
```

---

## 发布与回滚

### `scripts/release/publish_release.sh`

**用途**：macOS 发布到 Cloudflare R2。

**前置条件**：

- 已运行 `./scripts/build/build_macos.sh` 完成构建
- 已配置 `.env` 中的 R2、Apple 签名、Tauri 更新签名等环境变量

**执行内容**：

- 上传 DMG / tar.gz 到 R2
- 生成并上传更新清单（`darwin-aarch64.json`、`darwin-x86_64.json`、`latest.json`）
- 可选上传到 GitHub Release

**用法**：

```bash
./scripts/release/publish_release.sh
```

### `scripts/release/publish_windows.ps1`

**用途**：Windows 发布到 Cloudflare R2。

**前置条件**：

- 已运行 `.\scripts\build\build_windows.ps1` 完成构建
- 已配置 R2 环境变量

**用法**：

```powershell
.\scripts\release\publish_windows.ps1
```

### `scripts/release/upload_github_release_mac.sh`

**用途**：将 macOS 构建产物上传到 GitHub Release。

**说明**：

- 可独立运行
- 也被 `publish_release.sh` 调用

**用法**：

```bash
./scripts/release/upload_github_release_mac.sh
```

### `scripts/release/upload_github_release_win.ps1`

**用途**：将 Windows 构建产物上传到 GitHub Release。

**说明**：

- 可独立运行
- 也被 `publish_windows.ps1` 调用

**用法**：

```powershell
.\scripts\release\upload_github_release_win.ps1
```

### `scripts/release/upload_qr_code.sh`

**用途**：上传二维码到指定存储。

**用法**：

```bash
./scripts/release/upload_qr_code.sh
```

### `scripts/release/rollback_release.sh`

**用途**：macOS / Linux 回滚发布。

**用法**：

```bash
./scripts/release/rollback_release.sh
```

### `scripts/release/rollback_release.ps1`

**用途**：Windows 回滚发布。

**用法**：

```powershell
.\scripts\release\rollback_release.ps1
```

### `scripts/release/rebuild_clean.ps1`

**用途**：Windows 干净重建。

**执行内容**：

- 清理构建产物
- 重新执行完整构建

**用法**：

```powershell
.\scripts\release\rebuild_clean.ps1
```

---

## 通用辅助脚本

### `scripts/esbuild-bundle.mjs`

**用途**：统一打包 server / cli。

**用法**：

```bash
node scripts/esbuild-bundle.mjs server
node scripts/esbuild-bundle.mjs cli
```

### `scripts/setup-tsx-runtime.mjs`

**用途**：为目标平台准备自包含 tsx 运行时。

**用法**：

```bash
node scripts/setup-tsx-runtime.mjs
```

### `scripts/download_nodejs.sh`

**用途**：下载 Node.js v24.14.0 到 `src-tauri/resources/nodejs`。

**用法**：

```bash
./scripts/download_nodejs.sh
```

### `scripts/sync-version.js`

**用途**：将 `package.json` 版本同步到 `src-tauri/tauri.conf.json` 和 `src-tauri/Cargo.toml`。

**说明**：

- 由 `npm version` 钩子自动调用
- 通常不需要手动执行

---

## 典型工作流

### 首次开发

```bash
./scripts/setup/setup.sh
./scripts/dev/start_dev.sh
```

### macOS 生产发布

```bash
npm version patch
./scripts/build/build_macos.sh
./scripts/release/publish_release.sh
```

### Windows 生产发布

```powershell
npm version patch
.\scripts\build\build_windows.ps1
.\scripts\release\publish_windows.ps1
```

---

## 注意事项

- 所有脚本默认从项目根目录执行
- 生产构建和发布脚本需要正确配置 `.env` 中的签名和 R2 环境变量
- 详细构建流程请参阅 `specs/guides/` 下的各平台构建指南
