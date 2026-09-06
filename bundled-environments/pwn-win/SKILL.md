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

## 前置：模板 Windows VM（adopt 一键养成）

配方不带虚拟机本体。模板 = 一台已装 Windows 10/11（或 Server）+ VMware
Tools 的 VM（Tools 是引导通道的地板），用 adopt 一键养成：

```
zhishi env adopt pwn-win --vm "C:\VMs\win10-pwn\win10-pwn.vmx"
# 提示时输入 guest 管理员密码（现场使用，不落盘；非默认账号用 --user 指定）
```

adopt 全自动完成（Windows 路径走 vmrun 客户机通道开路）：启用 OpenSSH
Server 可选功能 + 起 sshd/防火墙 → 建 `researcher` 用户（管理员组，随机
本地密码——只公钥登录）→ 公钥落 `administrators_authorized_keys`（ACL
钉 Administrators/SYSTEM）→ scp + 跑本配方 setup.ps1（choco 工具集 +
环境配置 + 自检）→ `shutdown /s` → 做 `zhishi-clean` 快照 → 模板落
config.json。唯一地板：VMware Tools + 一个管理员账号的密码。

> 也可全程人备（装 Tools/OpenSSH/researcher 后 `env add --kind vm
> --os-family windows ...` 登记）——adopt 只是把这四步自动化。

## 初始化

adopt 已在养成时跑过 setup.ps1 并自检（缺工具不做快照）。已有环境也可
随时「补齐环境」（GUI ⋯ 菜单 / environment/setup）重放——幂等。要求
提升（管理员）会话——补齐链路预检 `net session`，非提升直接拒进场。

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

- **目录约定**：工作目录 `C:\zhishi-work\`（corpus/ crashes/ targets/ bin/；
  setup.ps1 已建并加 Defender 排除——fuzz 语料不被实时扫描拖慢/误杀）
- **源码 fuzz**：clang-cl `/fsanitize=fuzzer,address` 构建 harness →
  语料进 corpus/ → 长跑（env_bg 后台）→ 崩溃落 crashes/ → cdb 分拣
- **闭源 fuzz**：WinAFL（可选段）——DynamoRIO 插桩 + 目标函数偏移定位
  （per-target 人工环节）→ winafl-cmin 精简语料 → 同上回收
- **崩溃 triage**：`cdb -g -G -c ".lastevent; .ecxr; r; kb 5; q" <target> <样本>`
  批处理取现场（异常码/寄存器/顶帧）；批量栈指纹用
  `powershell -File C:\zhishi-work\bin\stack-hash.ps1 -TargetExe <exe> -Samples <样本...>`
  （ASan 输出与 cdb 双通道，crash-triager 深挖的验证门同 Linux 语义）；
  有 !exploitable（msec.dll）时 `!analyze -v; !exploitable` 拿可利用性参考
- **PageHeap（堆破坏显形器）**：`gflags /p /enable <target.exe> /full` 开
  （堆越界写提前变 AV）；调完 `gflags /p /disable <target.exe>` 关——
  开着会拖慢 fuzz 吞吐，别带进长跑
- **TTD（复现阶段的杀器）**：`ttd.exe -launch -out C:\zhishi-work\traces <program>`
  录 trace，之后 `cdb` 加载 `.run` 文件任意回放（`!tt <addr>` 时间旅行到
  任意指令）——比 Linux 的 rr 稳，一次录制无限复现
- **符号**：`_NT_SYMBOL_PATH` 已配 MS 公共符号服务器（setup.ps1 落用户环境变量）

## 结果怎么采

崩溃、dump（WER LocalDumps 在 `%LOCALAPPDATA%\CrashDumps`）、TTD trace 从
guest 拷回工作区：`/extract <环境内路径>`（GUI）或 scp。快照隔离环境污染，
但**结果文件不会自动出来**——收尾前记得采。

## 怎么收尾

`zhishi env down pwn-win`（stop soft 停 VM，文件不动）。现场不用收拾：
下次 `env up` 自动 revert 回 `zhishi-clean`。`zhishi env rm pwn-win` 只摘除
登记，VM 文件一律不碰。有效套路用 `zhishi research log` 记下来。
