---
name: browser-lab
description: 浏览器（Chrome 旧版）漏洞研究 VM 环境。当任务是 Chrome 渲染/V8 JIT/沙箱逃逸类 CVE 复现、网页样本崩溃 triage、浏览器解析面 fuzz 的受控执行现场时使用——版本钉死的 Chrome 目标（自动更新已关闭）+ MS 符号服务器自动配置 + cdb/TTD 崩溃显形，断网 guest 通道传样本，快照回滚保证每次进入都是干净现场。
base: vm
os_family: windows
vm_user: researcher
vm_snapshot: zhishi-clean
tools:
  - python
  - sysinternals
  - cdb
  - chrome-old
firstRunTools:
  - chrome-old
---

# browser-lab —— Chrome 旧版漏洞研究 VM 环境

## 何时用

- **浏览器 CVE 复现**——版本钉死的 Chrome 旧版目标（同版本同现场），渲染/
  V8 JIT/图形栈漏洞的 PoC 触达 → PageHeap 显形 → cdb `!analyze -v` 定栈 →
  TTD 回放定根因
- **网页样本崩溃 triage**——可疑 HTML/SWF/样本页的受控打开（断网 guest），
  崩溃捕获与批量栈指纹
- **解析面 fuzz 的受控执行**——DOM/JS 引擎语料的执行环境，fuzz 崩溃的
  dump/trace 回收
- 不可信样本交互需要 **hypervisor 级隔离**——断网 VM 走 vmrun guest-exec/
  push 通道，样本与产物都不落地宿主

## 前置：模板 Windows VM（adopt 一键养成）

配方不带虚拟机本体。模板 = 一台已装 Windows 10/11 + VMware Tools 的 VM，
用 adopt 一键养成：

```
zhishi env adopt browser-lab --vm "C:\VMs\win10-browser\win10-browser.vmx"
# 提示时输入 guest 管理员密码（现场使用，不落盘；非默认账号用 --user 指定）
```

adopt 全自动完成（vmrun 客户机通道开路）：启用 OpenSSH Server + 起 sshd/
防火墙 → 建 `researcher` 用户 → scp + 跑本配方 setup.ps1（符号配置 +
sysinternals/cdb 工具链 + Chrome 旧版钉死安装 + 自动更新关闭 + 自检）→
关机 → 做 `zhishi-clean` 快照 → 模板落 config.json。

## 初始化

setup.ps1 幂等可重放（GUI ⋯ 菜单 / environment/setup 随时「补齐环境」），
提升会话预检 `net session`。三件事按序做：

1. **符号自动配置（第一事）**：`_NT_SYMBOL_PATH=srv*C:\Symbols*https://msdl.microsoft.com/download/symbols`
   （Machine 级）+ C:\Symbols 预建。Chrome 符号（chrome.dll/v8 等 PDB）体积
   大，首次拉取慢属正常；栈只出地址 = 符号链没通。
2. **Chrome 旧版钉死目标**：首选 `winget install Google.Chrome --version
   <钉死版>`；winget 不可用/无该版本时回落下载块——Chrome for Testing
   官方仓库的钉死版本 zip（URL 与 sha256 钉在脚本头部常量；常量 TODO 占位
   时拒绝安装并打印获取指引）。安装后**自动更新已按纪律关闭**（组策略键 +
   更新器重命名）——复现现场最怕目标自己升级。
3. **工具链**：sysinternals 套件（官方 zip + Authenticode 验签）、cdb
   （Windows SDK Debugging Tools，探测命中即跳过安装）。

## 怎么进

```
zhishi env up browser-lab                          # 有 zhishi-clean 快照先 revert
zhishi env open browser-lab                        # SSH 进 guest
zhishi env exec browser-lab -- chrome --version    # 断网一次性命令（vmrun 通道）
zhishi env push browser-lab C:\work\poc.html C:/work/poc.html   # 样本进 guest
```

进现场先确认目标版本没被升级：`chrome --version` 必须等于钉死版——不等
说明自动更新漏关，先查策略键再谈复现。

## 标准工作流

- **目录约定**：工作目录 `C:\zhishi-work\`（samples/ crashes/ traces/ bin/；
  setup.ps1 已建并加 Defender 排除——JS 样本不被实时扫描抢先处决）
- **受控打开**：`Start-Process chrome.exe <样本页或 --headless 形态>`；沙箱
  行为差异留意（--no-sandbox 会改变攻击面语义，记录进 research log）；
  procmon 挂 chrome.exe 过滤器看子进程/文件行为
- **PageHeap（堆破坏显形）**：`gflags /p /enable chrome.exe /full`——渲染
  进程的堆越界写提前变 AV；chrome 多进程模型下崩溃的是 renderer/gpu 子
  进程，抓崩溃要看子进程名（--type=renderer）；调完 disable 关掉（性能
  代价大，别带进批量跑）
- **cdb 批处理 triage**：
  `cdb -g -G -c ".lastevent; .ecxr; r; kb 8; q" chrome.exe <样本>` 取现场；
  V8 崩溃常见形态：CHECK 失败/DCHECK（意图性 Crash）与真内存破坏分开记
- **TTD（根因定位杀器）**：`ttd.exe -launch -out C:\zhishi-work\traces chrome.exe <样本>`
  录制完整 trace，cdb 加载 `.run`：`!tt <addr>` 时间旅行——JIT 代码区
  （大地址匿名区）回溯看优化前后的执行差，一次录制无限复现
- **符号**：chrome.dll/content/v8 符号自动从符号服务器拉；V8 内置函数
  （Builtins）无 PDB 符号，看 `chrome!v8::internal::` 帧定逻辑位置

## 结果怎么采

崩溃 dump（WER LocalDumps 在 `%LOCALAPPDATA%\CrashDumps`，setup.ps1 已配
全转储）、TTD trace（C:\zhishi-work\traces\）、procmon 日志从 guest 拷回：
`/extract <环境内路径>`（GUI）或 scp。**结果文件不会自动出来**——收尾前
记得采。样本与 dump 过界提取走边界 ask。

## 怎么收尾

`zhishi env down browser-lab`（stop soft）。现场不用收拾：下次 `env up`
自动 revert 回 `zhishi-clean`（升级残留/策略漂移全回滚）。有效套路用
`zhishi research log` 记下来。
