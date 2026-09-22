---
name: win-kernel
description: Windows 内核/驱动研究 VM 环境。当任务是驱动/内核漏洞研究（自写驱动加载调试、IRP 处理逻辑验证）、驱动 fuzz 蓝屏 triage、BSOD 根因分析（!analyze -v、Verifier 定位）时使用——双机调试管道自动配（本机 WinDbg 经 vmware 命名管道 \\.\pipe\kd_win-kernel 直连 guest，env up 自动注入 vmx），guest 内 bcdedit 调试串口 + testsigning 已开，WDK/OSR Loader/Verifier 工具链，蓝屏即快照回滚，每次进入都是干净现场。
base: vm
os_family: windows
vm_user: researcher
vm_snapshot: zhishi-clean
tools:
  - wdk
  - windbg
  - osr-loader
  - verifier
firstRunTools:
  - wdk
debug:
  transport: pipe
  pipe: kd_win-kernel
---

# win-kernel —— Windows 内核/驱动研究 VM 环境

## 何时用

- **驱动/内核漏洞研究**——自写驱动的加载与交互调试（IRP 分发、IOCTL
  处理面）、内核 API 行为验证、竞争条件触发
- **驱动 fuzz 蓝屏 triage**——驱动 fuzzing 的 BSOD 现场（`!analyze -v`
  定因、Verifier 辅助定位堆头破坏/句柄泄漏）
- **BSOD 根因分析**——崩溃转储（MEMORY.DMP）完整落盘，符号链已配，
  蓝屏后快照回滚反复逼近根因
- 内核态实验需要 **hypervisor 级隔离 + 一键还原**——蓝屏是常态不是事故，
  `env up` 自动 revert 回干净现场

## 前置：模板 Windows VM + 调试管道（adopt 一键养成）

配方不带虚拟机本体。模板 = 一台已装 Windows 10/11 + VMware Tools 的 VM：

```
zhishi env adopt win-kernel --vm "C:\VMs\win10-kd\win10-kd.vmx"
# 提示时输入 guest 管理员密码（现场使用，不落盘；非默认账号用 --user 指定）
```

**debug 段机制（1.8.0）**：配方的 `debug: { transport: pipe, pipe:
kd_win-kernel }` 声明由 `env up` 消费——启动前自动向 vmx 注入串口管道
4 行（幂等，重复 up 不叠加）。vmware 的 kd 管道约定：**guest = server，
宿主调试器 = client**。guest 内 setup.ps1 已把调试串口开成 COM1
115200（`bcdedit /dbgsettings serial debugport:1 baudrate:115200`），
两端的管道与串口头在 `env up` 后自动对上。

## 怎么进

```
zhishi env up win-kernel        # revert zhishi-clean → 注入管道 → start
zhishi env open win-kernel      # SSH 进 guest（编译/加载/触发侧）
```

宿主侧（本机条目——1.7.8 已具备 WinDbg 探测/安装）连接调试管道：

```
windbg -k com:port=\\.\pipe\kd_win-kernel,pipe
# 管道两端就绪后 kd 握手：Connected to Windows ... —— 断点即命中
```

本机没有 WinDbg 先 `winget install Microsoft.WinDbg`（或 SDK 安装器勾选
Debugging Tools for Windows）。guest 文件操作走 `zhishi env push win-kernel
<本机 .sys> C:/work/<name>.sys`（断网也能走）。

## 标准工作流

- **驱动加载（OSR Loader）**：guest 内 `C:\tools\osr-loader\OSRLOADER.exe`——
  注册并启动服务（免手写 sc + 测试签名绕过繁琐步骤）；testsigning 已由
  setup.ps1 开启（setup 自检会验），未签名测试驱动可直接加载。命令行等价：
  `sc create <name> binPath= C:\work\<name>.sys type= kernel && sc start <name>`
- **调试会话**：WinDbg 断下来后常规打法——`bp <driver>!DriverEntry`、
  `!drvobj`/`!devobj` 看对象、`dt nt!_IRP` 看请求体；guest 内 `sc stop`/
  重载驱动即重进 DriverEntry，断点循环验证
- **Verifier（驱动体检仪）**：`verifier /standard /driver <name>` 开标准
  校验（特殊池/死锁/句柄检查），重启后生效；fuzz/触发阶段开着，让池破坏
  当场蓝在驱动帧而非延迟爆在别人家。关：`verifier /reset`
- **蓝屏纪律**：蓝屏 = 现场成型——先在 WinDbg 里 `!analyze -v` 看
  BUGCHECK_CODE 与 STACK_TEXT（符号链已配，内核帧应完整解析），再决定
  宿主 windbg 现场分析还是取转储后**直接快照回滚**：`zhishi env down
  win-kernel`（落盘转储需 guest 完成写入，稍等再 down）→ `env up` 回
  zhishi-clean。绝不在脏现场上叠加第二轮实验。
- **完整转储**：setup.ps1 已配 CrashControl 完整转储（%SystemRoot%\
  MEMORY.DMP，覆盖写）。蓝屏后 guest 内确认文件落盘再 down——内核态
  分析重度依赖完整转储，minidump 的栈与池信息不够。
- **编译链（operator 自决两路）**：guest 内装 VS Build Tools + WDK
  （重，WDK 本体 setup 已管）；或本机条目编译好 .sys push 进 guest
  （本机 MSVC/cdb 是现成探测面）。

## 结果怎么采

MEMORY.DMP（%SystemRoot%\MEMORY.DMP）、WinDbg 会话输出、驱动产物从
guest 拷回：`/extract <环境内路径>`（GUI）或 scp。宿主侧也可直接在
WinDbg 里 `.dump /ma C:\work\analysis.dmp` 存分析副本。崩溃驱动与转储
过界提取走边界 ask。

## 怎么收尾

`zhishi env down win-kernel`（stop soft；蓝屏后等转储写完）。现场不用
收拾：下次 `env up` 自动 revert 回 `zhishi-clean`（加载过的驱动、开过的
Verifier 全回滚——Verifier 状态在快照里，重开按需）。有效套路用
`zhishi research log` 记下来。
