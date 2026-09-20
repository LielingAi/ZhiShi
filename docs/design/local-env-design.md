# 本地研究环境（Windows 宿主）设计 —— 1.7.8

> 版本：2026-09-20 立项（WREN 拍板修订：**流程与其他环境一致，不引入新自动化**——探测/补装复用现有机制、人工点触发、大模型不参与环境配置）。
> 场景：Windows 本机漏洞研究（宿主机即靶标）。内核/BSOD 级研究仍走 pwn-win VM（快照回滚不可替代）。

## 1. 定位与语义

- 本地环境 = **内置已登记条目**（kind='local'，id='local'），应用开箱即有——**无需登记流程**（区别于 docker/VM/ssh 的 add/up；语义上等于把现有 HOST_SELECTION 从"禁用态"变成"可锚定环境"）
- 与其他环境**同一套流程**：选定 → 探测 → （人点）补装 → 研究。不新增"agent 自动配置"类机制

## 2. 执行通道

- `loop/env-exec.ts` `resolveExecTarget` 加 local 分支：宿主机直 spawn（win32 天然无 ControlMaster/ssh 问题）；超时/输出截断/边界钩子全复用
- bg 真相文件落 `%ProgramData%\zhishi-bg\`（os-family.ts 的 Windows 包装现成）
- term attach 复用 panel API 宿主 PTY（交互式 WinDbg/cdb 会话）

## 3. 探测与补装（复用现有件，零新自动化）

- **探测**：capability-derive 批量探测协议（OK:/MISS: 行）在本地通道跑——探测面：vswhere 查 MSVC、clang、cdb/WinDbg、python、git、WSL、符号路径（_NT_SYMBOL_PATH）→ 进能力清单
- **补装**：engine-install 同款半自动（**人点触发，脚本干活**，与 docker/hyperv 安装同一交互模式）：winget 官方源装 Build Tools / Windows SDK / WinDbg，验签
- 大模型不参与环境配置

## 4. 边界（local env 的 D14 口径）

- **全自动**：编译/跑 PoC/调试器/workspace 内文件写/读
- **越界 ask 新增 `system-config` 类**：bcdedit、reg add HKLM*、Set-ProcessMitigation -System、Set-MpPreference、netsh advfirewall、sc config、wevtutil cl、winget install——持久全局变更逐次问、无"永远允许"
- **恒生效**：credential-leak（命令文本不得含宿主凭据，与执行位置无关）
- 现有四类越界在 local 的处置：host-write → workspace 内免检（研究常态）；destroy-env → 不适用（无快照）；net-policy → 并入 system-config

## 5. 快照缺位警示

- 无回滚：BSOD 级实验自担；内核研究走 pwn-win
- 首次选定 local 时一次性提示；可选"研究前建系统还原点"走 system-config ask

## 6. 改动面

| 文件 | 改动 |
|---|---|
| `environment/registry.ts` + shared 类型 | kind 联合加 `'local'`；内置 local 条目（os_family=windows，无 keyPath/密码字段） |
| `loop/env-exec.ts` | resolveExecTarget local 分支（直 spawn） |
| `loop/boundary.ts` + `boundary-ask.ts` | system-config 规则（模式数组，数据驱动）+ 越界类别 |
| `loop/bg-exec.ts` | Windows 宿主真相文件路径 |
| `environment/capability-derive.ts` | local 探测面（vswhere/winget list） |
| `environment/engine-install.ts` | winget 半自动补装（Build Tools/SDK/WinDbg，官方源验签） |
| `environment/selection.ts` | local 可选定（原 HOST_SELECTION 语义转正） |
| `admin-api.ts` / `index.ts` / CLI | local 出现在 env list/current；探测刷新/补装入口 |
| `system-prompt-security.ts` | native-code 段适配：工具链在宿主时的表述 |
| 测试 | exec local 通道（注入 spawn）、system-config 规则纯函数、capability 探测 mock、registry 兼容 |

GUI 深度入口（侧栏置顶 local、补装向导）不在本版，后续 slice。

## 7. 验收

裸 Windows 机：选定 local → 探测列出 MSVC/WinDbg 现状 → 缺失项人点补装 → agent 完成 MSVC 编译 + cdb 调试闭环；全程大模型零配置介入，人工只有选定 + 点补装 + 越界批准。
