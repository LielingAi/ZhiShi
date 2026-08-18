---
name: dev
description: 通用原生代码开发环境。当任务需要编写、编译、运行或调试 C/C++/汇编/Python 代码（exploit、PoC、fuzz harness、补丁复现、算法验证）时使用——宿主不装任何编译工具链，一切编译运行在环境内进行。覆盖 native code 闭环的全场景兜底环境。
base: docker
tools:
  - clang
  - gcc
  - g++
  - make
  - cmake
  - python3
  - pip3
  - gdb
  - lldb
  - git
  - curl
---

# dev —— 通用原生代码开发环境

## 何时用

任何需要编译/运行/调试代码的任务：写 exploit、PoC、fuzz harness、补丁 diff 复现、快速验证一段 C/汇编行为。**宿主没有编译器——不要尝试在宿主编译，进环境。**

## 怎么进

```
zhishi env up dev          # 首次构建镜像（几分钟），之后秒起
zhishi env open <id>       # 或 agent 直接 docker exec -it <container> bash
```

工作区自动挂载到容器内 `/workspace`——在宿主编辑器写的代码，环境内直接可见可编译。

## 怎么用（native code 闭环）

```
cd /workspace
clang -g -O0 exp.c -o exp        # 调试用 -g -O0； release 验证再换 -O2
./exp                            # 跑
gdb ./exp                        # 崩了进 gdb：run / bt / info registers
```

- Python 脚本同理：`python3 script.py`，缺包 `pip3 install <pkg>`（装在环境内，不污染宿主）。
- 长编译/长跑任务把输出重定向到 `/workspace/logs/` 下的文件，方便宿主编码侧读取与归档。

## 结果怎么采

编译产物、崩溃转储、运行日志全部落在 `/workspace`（即宿主工作区）——环境销毁不带走任何东西。**不要把成果只留在容器内路径。**

## 怎么收尾

- 任务结束：`zhishi env down <id>`（一次性环境，默认销毁）。
- 环境内临时装的包如果想长期保留：把 install 命令沉淀回本配方的 `Dockerfile` / `setup.sh`，重建镜像（配方迭代即经验沉淀）。
