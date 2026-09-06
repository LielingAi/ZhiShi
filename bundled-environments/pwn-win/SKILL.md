---
name: pwn-win
description: Windows 用户态漏洞研究 VM 环境。当任务是 Windows 目标的漏洞挖掘/验证/复现（PE 程序 fuzz、PoC 编写与崩溃 triage、1day 复现）时使用——以 VMware Workstation 模板 Windows VM 为基底，内置 git/python/clang-cl(libFuzzer+ASan)/cdb(WinDbg 引擎)/procdump/Ghidra 工具集，可选段补 VS Build Tools、WinAFL+DynamoRIO、x64dbg；快照约定保证每次进入都是干净现场。
base: vm
os_family: windows
vm_user: researcher
vm_snapshot: zhishi-clean
tools:
  - git
  - python
  - clang-cl
  - cdb
  - procdump
  - ghidra
---

# pwn-win —— Windows 用户态漏洞研究 VM 环境

## 何时用

- **Windows 目标的漏洞挖掘**——源码可见走 clang-cl + libFuzzer/ASan（与 Linux
  的 libFuzzer 工作流同构）；闭源走 WinAFL（可选段，harness 选型与目标函数
  定位是 per-target 的人工环节）
- **漏洞验证/复现**——cdb 批处理 triage（`!analyze -v`）、procdump/WER 崩溃
  捕获、gflags PageHeap 显形堆破坏、TTD 时间旅行调试回放
- **快照回滚**的反复尝试——每次 `env up` 自动 revert 到 `zhishi-clean`
- 不可信样本交互需要 **hypervisor 级隔离**（断网 VM 走 vmrun guest-exec/
  push 通道，无需网卡）

## 前置：模板 Windows VM（当前版本：人备，登记即用）

配方不带虚拟机本体。模板 = 一台已装 Windows 10/11（或 Server）的 VM：

1. 装 VMware Tools（断网通道的载体）；
2. 启用 OpenSSH Server（`Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0`，
   起服务 + 防火墙放行 + 设开机自启）——联网工作流的 SSH 通道靠它；
3. 建 `researcher` 用户（管理员组）并配好 keyPath 公钥——管理员用户的公钥
   放 `C:\ProgramData\ssh\administrators_authorized_keys`（不是用户目录的
   .ssh/authorized_keys，且该文件 ACL 只能留 Administrators/SYSTEM）；
4. 用 `zhishi env add --kind vm --id pwn-win --vm-name <VM名> --vmx <模板.vmx> --os-family windows --address <IP> --user researcher --key-path <私钥>` 登记
   （或 `zhishi env up pwn-win --vm-base <模板.vmx>`，os_family 由配方声明回写）。

> 全自动养成（adopt 的 Windows 路径）随 1.6.4 M2 提供——当前 adopt 仅支持
> apt 系 Linux guest，Windows VM 按上面四步人备。

## 初始化

登记后对条目跑一次「补齐环境」（GUI ⋯ 菜单）或服务端 environment/setup——
重放本配方 setup.ps1（choco 装工具集 + 环境配置 + 自检，幂等可重放）。
要求提升（管理员）会话——补齐链路预检 `net session`，非提升直接拒进场。

可选的重型组件（VS Build Tools VCTools 工作负载、WinAFL+DynamoRIO、
x64dbg）默认不装——在 guest 内设 `$env:ZHISHI_PWN_WIN_HEAVY='1'` 后重放
setup.ps1 才进场（VS Build Tools 是多 GB 下载，偶发重试属正常）。

## 怎么进

```
zhishi env up pwn-win                             # 有 zhishi-clean 快照先 revert
zhishi env open pwn-win                           # SSH 进 guest（远端默认 shell，通常 cmd.exe）
zhishi env exec pwn-win -- whoami /priv           # 断网 VM 的一次性命令（vmrun 通道）
zhishi env push pwn-win C:\work\poc.exe C:/work/poc.exe   # 传入文件（断网也能走）
```

`env up` 做的事与 linux VM 配方一致（D22 直连真实 VM，不拷贝）：已在跑则
幂等只刷新地址；否则存在 `zhishi-clean` 快照则 revert → 启动 → 回写地址。
osFamily 由 vmx guestOS 静态判定，读不到回落配方声明的 `os_family: windows`。

## 标准工作流

- **目录约定**：工作目录 `C:\zhishi-work\`（corpus/ crashes/ targets/；
  setup.ps1 已建并加 Defender 排除——fuzz 语料不被实时扫描拖慢/误杀）
- **源码 fuzz**：clang-cl `/fsanitize=fuzzer,address` 构建 harness →
  语料进 corpus/ → 长跑（env_bg 后台）→ 崩溃落 crashes/ → cdb 分拣
- **闭源 fuzz**：WinAFL（可选段）——DynamoRIO 插桩 + 目标函数偏移定位
  （per-target 人工环节）→ winafl-cmin 精简语料 → 同上回收
- **崩溃 triage**：`cdb -c "!analyze -v; kb; q"` 批处理；!exploitable 初判
  可利用性；TTD trace（`ttd.exe -launch`）录一次随便回放
- **符号**：`_NT_SYMBOL_PATH` 已配 MS 公共符号服务器（setup.ps1 落用户环境变量）

## 结果怎么采

崩溃、dump（WER LocalDumps 在 `%LOCALAPPDATA%\CrashDumps`）、TTD trace 从
guest 拷回工作区：`/extract <环境内路径>`（GUI）或 scp。快照隔离环境污染，
但**结果文件不会自动出来**——收尾前记得采。

## 怎么收尾

`zhishi env down pwn-win`（stop soft 停 VM，文件不动）。现场不用收拾：
下次 `env up` 自动 revert 回 `zhishi-clean`。`zhishi env rm pwn-win` 只摘除
登记，VM 文件一律不碰。有效套路用 `zhishi research log` 记下来。
