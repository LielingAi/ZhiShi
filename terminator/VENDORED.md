# Vendored: mediar-ai/terminator

本目录是 **mediar-ai/terminator 的 vendor 副本**，ZhiShi 内置 MCP preset
`terminator`（AppCraft 桌面自动化的 UIA 语义引擎）的自构建源码树。

- **上游**：https://github.com/mediar-ai/terminator （MIT）
- **基线 commit**：`73a381c`（Add workflow to publish Rust crates to crates.io）
- **vendor 时间**：2026-08-06（从 `tmp/terminator` 迁入仓库，`target/` 与 `.git/` 未带入）

## 本地改动（与上游的 diff）

| 位置 | 改动 | 原因 |
|---|---|---|
| `crates/terminator-mcp-agent/src/main.rs` | `PATCH(zhishi)` 注释处（+6 行）：chcp 子进程 detach stdio | 上游 bug：chcp 子进程继承 stdout，污染 MCP stdio 通道，导致 MCP 握手解析失败 |
| `crates/terminator/examples/diag_*.rs`、`spike_notepad.rs` | 新增（未跟踪于上游） | 当时诊断 UIA 元素树的试验代码，留作参考 |

## 升级流程

1. `git clone https://github.com/mediar-ai/terminator` 到临时目录，checkout 目标版本
2. 把本目录的 PATCH 段重新应用到新版本（搜 `PATCH(zhishi)`）
3. 用 `scripts/build/publish_terminator_r2.ps1 -SourceDir <本目录> -Version <vX.Y.Z> [-Upload]` 构建并发布
4. 用构建产物替换 `src-tauri/binaries/terminator-mcp-agent-x86_64-pc-windows-msvc.exe`
5. 更新本文件的基线 commit
