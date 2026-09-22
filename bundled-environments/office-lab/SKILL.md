---
name: office-lab
description: Office 恶意文档/漏洞研究 VM 环境。当任务是 Word/Excel/PowerPoint 目标的恶意文档分析（宏/VBA/嵌入对象/DDE）、Office CVE 复现、OOXML/RTF 解析面 fuzz 与崩溃 triage 时使用——版本钉死的 Office 2019 目标 + MS 符号服务器自动配置 + oletools 静态拆解工具链 + PageHeap/TTD 崩溃显形，断网 guest 通道传样本（不落地宿主），快照回滚保证每次进入都是干净现场。
base: vm
os_family: windows
vm_user: researcher
vm_snapshot: zhishi-clean
tools:
  - python
  - oletools
  - sysinternals
  - cdb
  - office-2019
firstRunTools:
  - office-2019
---

# office-lab —— Office 恶意文档/漏洞研究 VM 环境

## 何时用

- **恶意文档分析**——可疑 Word/Excel/PowerPoint/RTF 样本的宏提取、嵌入对象
  拆解、DDE/链接判定（oletools 静态先行，动态打开只发生在断网 guest 内）
- **Office CVE 复现**——版本钉死的 Office 2019 目标（同 build 同现场），
  PoC 触达 → PageHeap 显形堆破坏 → cdb `!analyze -v` 定栈 → TTD 回放定根因
- **解析面 fuzz / 崩溃 triage**——野样本崩溃的批量分拣（cdb 批处理 +
  stack-hash 指纹），fuzz 语料的受控执行环境
- 不可信样本交互需要 **hypervisor 级隔离**——断网 VM 走 vmrun guest-exec/
  push 通道，样本与产物都不落地宿主

## 前置：模板 Windows VM（adopt 一键养成）

配方不带虚拟机本体。模板 = 一台已装 Windows 10/11 + VMware Tools 的 VM，
用 adopt 一键养成：

```
zhishi env adopt office-lab --vm "C:\VMs\win10-office\win10-office.vmx"
# 提示时输入 guest 管理员密码（现场使用，不落盘；非默认账号用 --user 指定）
```

adopt 全自动完成（vmrun 客户机通道开路）：启用 OpenSSH Server + 起 sshd/
防火墙 → 建 `researcher` 用户 → scp + 跑本配方 setup.ps1（符号配置 +
oletools/sysinternals/cdb 工具链 + Office 2019 首跑安装 + 自检）→ 关机 →
做 `zhishi-clean` 快照 → 模板落 config.json。

## 初始化

setup.ps1 幂等可重放（GUI ⋯ 菜单 / environment/setup 随时「补齐环境」），
提升会话预检 `net session`。三件事按序做：

1. **符号自动配置（第一事）**：`_NT_SYMBOL_PATH=srv*C:\Symbols*https://msdl.microsoft.com/download/symbols`
   （Machine 级）+ C:\Symbols 预建。MS 公共符号按需拉取缓存——cdb 的
   `!analyze -v` 与 TTD 栈还原都靠它；首次分析某模块会慢，属正常。
2. **Office 2019 钉死目标**：下载 URL 与 sha256 钉在 setup.ps1 头部常量。
   常量留占位（TODO）时脚本**拒绝安装**并打印获取指引（ODT 官方来源 +
   hash 算法）——operator 填常量后重放 setup.ps1 进场；探测命中已装则跳过。
   Office 激活（KMS/MAK）是 operator 场外事项，脚本不碰凭据。
3. **工具链**：oletools（`pip install oletools`，olevba/oleid/mraptor）、
   sysinternals 套件（官方 zip + Authenticode 验签）、cdb（Windows SDK
   Debugging Tools，探测命中即跳过安装）。

## 怎么进

```
zhishi env up office-lab                          # 有 zhishi-clean 快照先 revert
zhishi env open office-lab                        # SSH 进 guest
zhishi env exec office-lab -- olevba C:\work\sample.docm   # 断网一次性命令（vmrun 通道）
zhishi env push office-lab C:\work\sample.docm C:/work/sample.docm   # 样本进 guest
```

## 标准工作流

- **目录约定**：工作目录 `C:\zhishi-work\`（samples/ crashes/ traces/ bin/；
  setup.ps1 已建并加 Defender 排除——宏样本不被实时扫描抢先处决）
- **静态拆解先行**（不打开文档）：
  `olevba sample.docm`（宏代码 + 可疑关键字）、`oleid sample.docm`（包类型/
  宏/外链/DDE 风险总览）、`mraptor sample.docm`（攻击面三角判定）。RTF 走
  `olevba -r sample.rtf`；嵌入对象解包 `oledir.py` / `oleobj`。
- **受控打开**（动态行为只看断网 guest 内）：确认静态无致命项后，guest 内
  手动打开或 `Start-Process winword.exe <样本>`；procmon 挂过滤器
  （Process Name is winword.exe）看进程/文件/注册库行为
- **PageHeap（堆破坏显形）**：`gflags /p /enable winword.exe /full`（excel/
  powerpnt 同理）——堆越界写提前变 AV，复现率低的漏洞现形；调完
  `gflags /p /disable winword.exe` 关（开着启动慢，别带进批量跑）
- **cdb 批处理 triage**：
  `cdb -g -G -c ".lastevent; .ecxr; r; kb 8; q" winword.exe <样本>` 取现场
  （异常码/寄存器/顶帧）；栈指纹批量分拣同 pwn-win 的 stack-hash.ps1 协议
- **TTD（根因定位杀器）**：`ttd.exe -launch -out C:\zhishi-work\traces winword.exe <样本>`
  录制完整执行 trace，cdb 加载 `.run`：`!tt <addr>` 时间旅行到异常前任意
  指令，正向/反向单步看堆破坏现场如何形成——一次录制无限复现，比反复
  撞崩溃稳定得多
- **符号校验**：栈里 `winword!` 帧正常解析 = 符号链 OK；只出地址 = 跑
  `symchk /r C:\Symbols` 或重放 setup.ps1 确认 `_NT_SYMBOL_PATH`

## 结果怎么采

崩溃 dump（WER LocalDumps 在 `%LOCALAPPDATA%\CrashDumps`，setup.ps1 已配
全转储）、TTD trace（C:\zhishi-work\traces\）、procmon 日志从 guest 拷回：
`/extract <环境内路径>`（GUI）或 scp。**结果文件不会自动出来**——收尾前
记得采。样本与 dump 过界提取走边界 ask（敏感件不静默出 guest）。

## 怎么收尾

`zhishi env down office-lab`（stop soft）。现场不用收拾：下次 `env up`
自动 revert 回 `zhishi-clean`（宏样本改过的注册表/模板全回滚）。有效套路
用 `zhishi research log` 记下来。
