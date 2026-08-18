# 第三方补丁存档

本目录保存对第三方依赖的本地补丁——上游未合入、但我们的发布产物依赖它们。
**这些是发布二进制的事实来源的一部分，删了就无法复现构建。**

## terminator-mcp-agent-stdio-detach.patch

- **上游**：https://github.com/mediar-ai/terminator（本地 clone：`tmp/terminator`，gitignored）
- **基线 commit**：`73a381c`（2026-07 克隆时点）
- **影响产物**：`src-tauri/binaries/terminator-mcp-agent.exe`（tauri externalBin，
  AppCraft 回放引擎的 UI 自动化通道）
- **问题**：`main.rs` 启动时 spawn `chcp 65001` 切 UTF-8 代码页，但子进程继承了
  我们的 stdout——"Active code page: 65001" 直接打进 MCP JSON-RPC 流，
  破坏宿主侧的 MCP framing。
- **修复**：spawn 时 `stdin/stdout/stderr` 全部 `Stdio::null()` 脱离（6 行）。

### 重新构建二进制时如何应用

```powershell
cd tmp/terminator   # 或新 clone 的 mediar-ai/terminator（先 checkout 到兼容基线）
git apply E:\code\u-disk\src-tauri\patches\terminator-mcp-agent-stdio-detach.patch
cargo build --release -p terminator-mcp-agent
# 产物复制为 src-tauri/binaries/terminator-mcp-agent-x86_64-pc-windows-msvc.exe
```

### 备注

- `tmp/terminator/crates/terminator/examples/` 下还有 4 个本地诊断 spike
  （`diag_*.rs` / `spike_notepad.rs`，AppCraft 调试期产物）——非发布依赖，未存档。
- 长期正解：给上游提 PR（patch 里有 PATCH(zhishi) 标记说明意图）；gh 账号
  重新认证后可做。
