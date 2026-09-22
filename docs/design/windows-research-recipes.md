# Windows 研究配方族（office-lab / browser-lab / win-kernel）设计 —— 1.8.0

> 版本：2026-09-22 立项（WREN 拍板：域渗透挂起，主攻内核调试 + Office/浏览器）。
> 基础：1.7.11 现码机制全部复用——配方 = SKILL.md（frontmatter + 说明书）+ setup.ps1；
> 能力集合 = 配方绑定域 ∪ 实机探测域（capability-derive）；快照/回滚/断网 guest 通道/vm_base 模板语义全部现成。
> 本版唯一机制增量：`debug:` frontmatter 段（win-kernel 专用，vmx 注入）。

## 1. 范围

| 配方 | 定位 | 机制增量 |
|---|---|---|
| `office-lab` | Office 恶意文档/漏洞研究 VM | 零（纯内容件） |
| `browser-lab` | 浏览器（Chrome/Edge 旧版）漏洞研究 VM | 零（复制 office-lab 模板） |
| `win-kernel` | 驱动/内核双机调试 VM | `debug:` 段 + vmx 注入（~30 行） |

明确不做：AD/域渗透（拓扑组网机制另立项）；GUI console（guest 画面不可见，无头为主）。

## 2. office-lab / browser-lab（同构模板）

### frontmatter

```yaml
name: office-lab                      # browser-lab 同构
description: Office 漏洞研究 VM。版本钉死的 Office 目标 + 符号自动配置 + 恶意文档工具链 + PageHeap/TTD 崩溃显形；快照回滚保证每次干净现场。
base: vm
os_family: windows
vm_user: researcher
vm_snapshot: zhishi-clean
tools: [python, oletools, sysinternals, cdb, office-2019]
firstRunTools: [office-2019]           # 本体大件按需装（可选段机制现成）
```

browser-lab 差异：tools `[python, sysinternals, cdb, chrome-old]`、firstRunTools `[chrome-old]`。

### setup.ps1 三件事（供应链纪律写死）

1. **符号自动配置**（两个配方第一件都做）：
   `[Environment]::SetEnvironmentVariable('_NT_SYMBOL_PATH', 'srv*C:\Symbols*https://msdl.microsoft.com/download/symbols', 'Machine')`
   + 目录预建 C:\Symbols。说明书教 symchk 拉取与缓存校验。
2. **版本钉死的目标安装**：
   - office-lab：Office 2019 特定 build——下载 URL 与 sha256 **钉死在 setup.ps1 头部常量**，下载后 `Get-FileHash` 校验，不符即删并报错（D-T2 纪律的配方级落地）
   - browser-lab：Chrome 旧版安装包同理（离线安装包 + 关闭自动更新策略：组策略键或 rename 更新器——写进脚本）
3. **工具链**：oletools（`pip install oletools`）、sysinternals 套件（官方下载 + Authenticode 验签）、cdb 随 Windows SDK 分支（探测命中即跳过安装）。

### SKILL.md 教学要点（说明书 = 模型的工作手册）

- **何时用**：恶意文档分析 / Office CVE 复现 / 浏览器渲染或 JIT 漏洞复现
- **工作流**：oletools 静态拆文档（olevba/oleid/mraptor）→ 受控打开（断网 guest）→ PageHeap 显形堆破坏（`gflags /p /enable winword.exe /full`）→ cdb 批处理 triage（`!analyze -v`）→ TTD 时间旅行回放定位根因
- **崩溃证据回收**：procdump/WER 转储位置、核心转储落盘路径
- **纪律**：每次 up 自动 revert zhishi-clean；样本只进断网 guest；产物过界提取走边界 ask

### 探测映射增量（capability-derive）

TOOL_PROBE_COMMANDS 加词（windows 探测走 `where` 之外的特例）：
- `office-2019` → `reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall" /s /f "Microsoft Office"` 存在性粗探
- `chrome-old` → 文件版本探测（`chrome.exe --version` 或 PE 版本查询）
- `oletools`/`sysinternals` → `where olevba` / `where procmon`

## 3. win-kernel（唯一机制增量）

### frontmatter：`debug:` 段

```yaml
name: win-kernel
description: Windows 内核/驱动研究 VM。双机调试管道自动配（本机 WinDbg 直连 guest），WDK 按需装，蓝屏即快照回滚。
base: vm
os_family: windows
vm_user: researcher
vm_snapshot: zhishi-clean
tools: [wdk, windbg, osr-loader, verifier]
firstRunTools: [wdk]
debug:
  transport: pipe            # 仅支持 vmware 命名管道（v1）
  pipe: kd_win-kernel        # 本机 \\.\pipe\ 端点名
```

### 机制改动（两处，~30 行）

1. `recipes.ts`：`RecipeFrontmatter` 加 `debug?: { transport: 'pipe'; pipe: string }`；validate 校验（transport 枚举、pipe 白名单 `[\w.-]+`、仅 vmware 引擎）。
2. `vm-lifecycle.ts vmEnvUp`：解析出 vmx 后、start 前——vmx 追加/幂等更新串口管道 4 行：
   `serial0.present="TRUE"` / `serial0.fileType="pipe"` / `serial0.fileName="\\.\pipe\<pipe>"` / `serial0.startConnected="TRUE"`（vmware 的 kd 管道约定：guest=server，host debugger=client）。
   已存在同 fileName 的 serialN 则跳过（幂等，防重复 up 叠加）。

### setup.ps1（guest 内，界内全自动）

1. `bcdedit /debug on`
2. `bcdedit /dbgsettings serial debugport:1 baudrate:115200`
3. `bcdedit /set testsigning on`（OSR loader 等非签名驱动的加载前提；guest 内持久变更不触发宿主 system-config 边界——边界规则只管 env.kind==='local'）
4. WDK 可选段（firstRunTools 机制：下载 + sha256 校验 + 静默安装）

### 研究闭环（说明书教）

本机环境（1.7.8 已具备 WinDbg 探测/安装）执行：
`windbg -k com:port=\\.\pipe\kd_win-kernel,pipe` → 驱动源码 guest 内编译（WDK + osr loader 加载）→ 断点/单步 → 蓝屏 → guest 快照 revert → 继续。
分析面：`!analyze -v`、崩溃转储（`%SystemRoot%\MEMORY.DMP` 配置完整转储）、Verifier（`verifier /standard /driver <name>`）开法。

## 4. 共同工作项

1. 三个配方目录（bundled-environments/）：SKILL.md + setup.ps1（内容大头）
2. 上述机制两处（recipes.ts / vm-lifecycle.ts）+ 探测映射（capability-derive）
3. domain.json：三配方挂 binary 域（task_kind 复用 binary，research-kinds 不加新值）
4. bump `ENVIRONMENT_RECIPES_VERSION`（src-tauri/commands.rs）
5. 测试：validateRecipe 的 debug 段校验用例、vmx 注入幂等用例（纯函数抽出）、探测映射用例

## 5. 验证计划

- 单测全绿（上列用例）
- 实机 dogfood（需 Windows VM 模板）：`zhishi env adopt win-kernel --vm <vmx>` → up → 本机 windbg -k 连上（断点命中即闭环成立）；office-lab 走 oletools → PageHeap → cdb triage 一趟

## 6. 边界与安全

- 所有下载件 sha256 钉死（D-T2）；sysinternals/驱动工具 Authenticode 验签
- testsigning/debug 变更只发生在 guest 内（界内全自动）；宿主侧 system-config 边界不受影响
- 断网 guest 通道（vm-guest-exec）是样本/驱动的默认路径——说明书写成默认纪律
