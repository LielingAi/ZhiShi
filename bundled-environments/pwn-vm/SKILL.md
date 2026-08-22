---
name: pwn-vm
description: 二进制利用（pwn）VM 研究环境。当任务需要完整 VM 隔离（内核调试、双机调试、快照反复回滚的利用开发、不可信样本的动态分析）而 docker 容器不够用时使用——以 VMware Workstation 模板 VM 为基底，内置 gdb、pwntools、ROPgadget、checksec 工具集（pwndbg 按需补装，见下），快照约定保证每次进入都是干净环境。
base: vm
vm_user: researcher
vm_snapshot: zhishi-clean
tools:
  - gdb
  - pwntools
  - ROPgadget
  - checksec
  - socat
  - nc
  - python3
---

# pwn-vm —— 二进制利用 VM 研究环境

## 何时用

与 docker 版 pwn 配方同族，但选 VM 基底的场景：

- 需要**快照回滚**的利用开发——每次 `env up` 自动 revert 到 `zhishi-clean`，污染环境随手丢弃
- 内核调试 / 双机调试（docker 给不了独立内核）
- 不可信样本动态分析需要**hypervisor 级隔离**（容器共享宿主内核，不够）

## 前置：模板 VM（人发起，自动养成）

配方不带虚拟机本体。模板 = 一台已有系统的 VM（Ubuntu Server 建议），
用 adopt 一键养成：

```
zhishi env adopt pwn-vm --vm "C:\VMs\ubuntu-pwn\ubuntu-pwn.vmx"
# 公钥不通时会提示现场输入 guest 密码（不落盘）
```

adopt 全自动完成：找地址（Tools / DHCP 租约反查）→ 装 open-vm-tools +
openssh-server（若缺）→ 建 `researcher` 用户 + 写入公钥 → 跑本配方
setup.sh → 关机 → 做 `zhishi-clean` 快照 → 模板落 config.json。
唯一地板：guest 至少有 sshd 或 VMware Tools 之一（apt 系系统）。

## 怎么进

```
zhishi env up pwn-vm                            # adopt 后免 --vm-base
zhishi env open pwn-vm                          # SSH 进 guest（地址 up 时自动回写）
```

`env up` 做的事（D22 直连真实 VM，**不拷贝**——VM 本身就是环境）：已在跑则
幂等只刷新地址；否则存在 `zhishi-clean` 快照则 revert → `vmrun start nogui`
→ `getGuestIPAddress -wait` 拿地址并回写 env 条目（id = 配方名）。

## 初始化（adopt 已全自动完成）

`env adopt` 会在 guest 内跑本配方的 setup.sh（装工具集 + 自检）并在关机后
做 `zhishi-clean` 快照。之后每次 up 都回到这个干净现场。模板若手动改过，
重新 adopt 一次即可刷新。

## 标准工作流

与 docker 版 pwn 配方一致：checksec 看保护 → gdb 定偏移调现场 →
pwntools 写 exp → socat 起服务打。样本经 SSH（scp/sftp 或共享目录）
带进 guest，结果落回工作区。

**pwndbg 按需补装**（github 直连在部分网络不可用，故不进模板关键路径）：
`git clone --depth 1 https://github.com/pwndbg/pwndbg ~/pwndbg && cd ~/pwndbg && ./setup.sh`。
补装发生在 VM 内，下次 up 的快照回滚会丢弃——常用的话装好后重新 adopt 刷新快照。

## 结果怎么采

exp、cyclic 分析、core dump 从 guest 拷回工作区（scp）。快照隔离了
环境污染，但**结果文件不会自动出来**——收尾前记得采。

## 怎么收尾

`zhishi env down pwn-vm`（stop soft 停 VM，文件不动——这是你的真实 VM）。
现场不用收拾：下次 `env up` 自动 revert 回 `zhishi-clean` 干净现场。
`zhishi env rm pwn-vm` 只摘除登记（env 条目），VM 文件一律不碰。有效的
套路用 `zhishi research log` 记下来，蒸馏弧会沉淀。
