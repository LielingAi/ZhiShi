---
name: fuzz-vm
description: 模糊测试（fuzzing）VM 环境。当 fuzz 任务需要 VM 级隔离与快照回滚（跑不可信目标的 fuzz、内核 fuzz、AFL 核心绑定要独占整机性能）而 docker 容器不够用时使用——VMware 环境养成（adopt/build）后直连该真实 VM（D22：不拷贝派生），内置 AFL++ 全家，崩溃经 scp 落回工作区。
base: vm
vm_user: researcher
vm_snapshot: zhishi-clean
tools:
  - afl-clang-fast
  - afl-clang-lto
  - afl-gcc
  - afl-fuzz
  - afl-tmin
  - afl-cmin
  - afl-showmap
  - clang
  - gcc
  - python3
  - gdb
---

# fuzz-vm —— 模糊测试 VM 环境

## 何时用

与 docker 版 fuzz 配方同族，选 VM 基底的场景：

- **跑不可信目标的 fuzz**——hypervisor 级隔离，容器共享宿主内核不够
- **内核 / 驱动 fuzz**（docker 给不了独立内核）
- **性能独占**——AFL 核心绑定要整机独占，VM 资源隔离干净
- **快照回滚**——每次 `env up` 回到 `zhishi-clean` 干净现场

## 前置：模板（人发起，自动养成）

```
zhishi env adopt fuzz-vm --vm "C:\VMs\ubuntu-fuzz\xxx.vmx"   # 已有系统的 VM
zhishi env build fuzz-vm                                      # 什么都没有，从零自动装
```

## 怎么进

```
zhishi env up fuzz-vm
zhishi env open fuzz-vm                      # SSH 进 guest
```

语料/结果经 scp 进出（guest 无工作区挂载——VM 隔离的代价，也是本意）：

```
scp -i <keyPath> -r ./corpus-in researcher@<address>:~/
scp -i <keyPath> -r researcher@<address>:~/corpus-out ./
```

## 标准工作流

与 docker 版 fuzz 配方一致：harness 编写 → `afl-clang-fast` 插桩编译 →
`afl-fuzz -i corpus-in -o corpus-out` → crashes 研判（gdb / afl-tmin）。
长跑 fuzz 交给 `fuzz-runner` subagent 后台跑；崩溃去重初判交 `crash-triager`。

- VM 里 `AFL_SKIP_CPUFREQ=1` 通常仍需要（guest 的 cpufreq 由 hypervisor 管）
- 快照回滚 = 免费的环境重置：fuzz 搞脏了 guest,`env down` 后下次 `env up` 自动回 `zhishi-clean`

## 结果怎么采

crashes 必须 scp 回工作区（**guest 内文件不会自动出来**,down 前记得采）。
研判结论用 `zhishi research log` 记录（outcome/bug_class），蒸馏弧按域沉淀。

## 怎么收尾

`zhishi env down fuzz-vm`（stop soft 停 VM，文件不动——这是你的真实 VM）；
现场随下次 `env up` 的 revert 自动重置回 `zhishi-clean`。确认不要这个
环境了 `zhishi env rm fuzz-vm`——只摘登记，VM 文件一律不碰。
