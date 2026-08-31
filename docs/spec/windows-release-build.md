# Windows 正式发布构建说明

本文档说明 ZhiShi Windows 端正式版（NSIS 安装包 + 便携 ZIP）的构建机制、常见问题及验证方法。

## 1. 概览

- 目标平台：`x86_64-pc-windows-msvc`
- 主要产物：
  - `ZhiShi_<版本>_x64-setup.exe`：NSIS 安装包，内置 Git for Windows 安装包
  - `ZhiShi_<版本>_x86_64-portable.zip`：便携版压缩包
- 入口脚本：`scripts/build/build_windows.ps1`

## 2. 核心问题：Tauri v2 资源收集不稳定

Tauri v2 在 Windows 上打包 `bundle.resources` 时会尊重 `.gitignore`。只要资源文件被 `.gitignore` 匹配（例如 `server-dist.js`、`nodejs/`、`cli/`、`sqlite-runtime/` 等），即使 `tauri.conf.json` 中显式配置，也可能被静默排除，导致安装后应用启动失败。

因此不能依赖 Tauri 的默认资源收集机制来打包这些关键文件。

## 3. 解决方案：NSIS 显式资源宏

构建流程采用“最小化 Tauri 配置 + 自定义 NSIS 模板显式复制资源”的方案：

1. 生成临时配置 `src-tauri/tauri.windows.generated.conf.json`，仅注入 Windows NSIS hooks，不再通过 `bundle.resources` 让 Tauri 收集资源。
2. 调用 `scripts/build/patch_nsis.py` 在自定义 NSIS 模板 `src-tauri/nsis/installer.nsi` 中注入 `_ZHISHI_EXTRA_RESOURCES` 宏。
3. 该宏使用绝对路径显式复制所有必需资源到 `$INSTDIR`，绕过 Tauri 的资源 walker。
4. 构建结束后，脚本自动恢复被补丁修改的 `installer.nsi`，避免把机器相关绝对路径提交到仓库。

### 3.1 由 NSIS 宏负责复制的资源

- `server-dist.js`
- `sqlite-runtime/`
- `tsx-runtime/`
- `nodejs/`
- `shared/`
- `bundled-skills/`
- `bundled-environments/`
- `bundled-agents/`
- `cli/`
- `en.lproj/`、`zh-Hans.lproj/`
- `vcruntime140.dll`、`vcruntime140_1.dll`

### 3.2 Git 安装包

`src-tauri/nsis/Git-Installer.exe` 原模板中使用相对路径，在不同构建目录深度下会找不到文件。`patch_nsis.py` 会把它修正为绝对路径，确保 Git 安装包正确嵌入 NSIS 安装包。

## 4. 关键文件

| 文件 | 作用 |
|------|------|
| `scripts/build/build_windows.ps1` | Windows 正式发布构建主脚本：检查环境、构建前后端、打 NSIS 补丁、调用 Tauri 构建、生成便携 ZIP、清理临时文件。 |
| `scripts/build/patch_nsis.py` | 给 `src-tauri/nsis/installer.nsi` 注入额外资源宏，并修正 Git 安装包路径。 |
| `src-tauri/nsis/installer.nsi` | 自定义 NSIS 模板。构建时被动态补丁，构建后自动恢复。 |
| `src-tauri/nsis/hooks.nsh` | 安装/卸载前钩子，用于清理残留的 ZhiShi 后台进程。 |
| `src-tauri/tauri.windows.conf.json` | Windows 专用最小配置，仅保留 NSIS hooks。 |
| `src-tauri/tauri.windows.generated.conf.json` | 构建时生成的临时配置，不提交到仓库。 |

## 5. 构建流程

```powershell
# 在 Windows PowerShell 中执行
.\scripts\build\build_windows.ps1
```

可选参数：

- `-SkipTypeCheck`：跳过 TypeScript 类型检查
- `-SkipFrontend`：已废弃（前端 GUI 已删除，无窗口后台宿主形态；参数保留为 no-op 以兼容旧调用）
- `-SkipPortable`：不生成便携 ZIP
- `-SkipBundle`：只编译，不打包 NSIS
- `-USBMode`：USB 离线模式，禁用自动更新并使用 `hooks-usb.nsh`

## 6. 环境变量要求

| 变量 | 说明 |
|------|------|
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri updater 签名私钥。未设置时构建会报错，但 exe 仍生成；正式发版必须配置。 |

`TAURI_SIGNING_PRIVATE_KEY` 缺失时脚本会给出警告并询问是否继续；继续构建的最终产物可用，但 updater 签名失败、自动更新不可用。

## 7. 产物位置

```
src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/ZhiShi_<版本>_x64-setup.exe
src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/ZhiShi_<版本>_x86_64-portable.zip
```

## 8. 验证清单

构建完成后，建议静默安装到一个空目录并检查：

```powershell
$exe = "src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/ZhiShi_1.0.0_x64-setup.exe"
& $exe /S /D=C:\zhishi-test
```

检查安装目录是否包含：

- [ ] `nodejs/`
- [ ] `sqlite-runtime/`
- [ ] `tsx-runtime/`
- [ ] `cli/`
- [ ] `shared/`
- [ ] `bundled-skills/`
- [ ] `bundled-environments/`
- [ ] `bundled-agents/`
- [ ] `en.lproj/`、`zh-Hans.lproj/`
- [ ] `server-dist.js`
- [ ] `vcruntime140.dll`、`vcruntime140_1.dll`
- [ ] 安装包大小应明显大于不含 Git 安装包的情况（当前约 185 MB，其中 Git 安装包约 66 MB）

启动应用后确认：

- [ ] system skills 同步成功（`~/.zhishi/skills/`）

## 9. 常见故障排查

### 9.1 构建脚本中文乱码或解析失败

`build_windows.ps1` 已保存为 UTF-8 BOM。如果再次编辑后丢失 BOM，PowerShell 5.1 可能无法正确解析中文字符串，可用以下命令重新写入 BOM：

```powershell
$path = "scripts/build/build_windows.ps1"
$content = Get-Content -Raw -Encoding UTF8 $path
$enc = New-Object System.Text.UTF8Encoding($true)
[System.IO.File]::WriteAllText($path, $content, $enc)
```

### 9.2 安装后缺少 `nodejs` 等资源

检查 `scripts/build/patch_nsis.py` 是否被正确调用，以及 `src-tauri/nsis/installer.nsi` 中的 `_ZHISHI_EXTRA_RESOURCES` 宏是否包含对应资源路径。确认构建目录下 `target/x86_64-pc-windows-msvc/release/nsis/x64/installer.nsi` 已渲染为绝对路径。

### 9.3 Git 安装包未嵌入

- 确认 `src-tauri/nsis/Git-Installer.exe` 存在。
- 确认渲染后的 `target/.../release/nsis/x64/installer.nsi` 中 Git 安装包路径为绝对路径。
- 正常嵌入 Git 后，安装包应比未嵌入时大 60 MB 以上。

### 9.4 Updater 签名失败但 exe 已生成

本地缺少 `TAURI_SIGNING_PRIVATE_KEY` 属于预期行为。正式发版前务必配置该变量，否则自动更新不可用。

## 10. 注意事项

- 不要直接修改 `src-tauri/nsis/installer.nsi` 中的资源路径为绝对路径后提交。应修改 `patch_nsis.py`，让构建时动态注入。
- `src-tauri/tauri.windows.generated.conf.json` 和 `src-tauri/nsis/installer.nsi.bak` 都是构建临时产物，不需要提交。
- 便携 ZIP 不包含 Git 安装包；如果目标机器没有 Git，仍需通过 NSIS 安装包安装。
