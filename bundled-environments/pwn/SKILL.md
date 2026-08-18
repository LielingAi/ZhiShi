---
name: pwn
description: 二进制利用（pwn）研究环境。当任务是 0day 挖掘、1day 复现、漏洞利用开发、二进制逆向分析、exp 编写调试时使用——内置 gdb+pwndbg、pwntools、ROPgadget/ropper、checksec、socat 的完整利用链工具集，目标二进制经工作区挂载进环境分析。
base: docker
tools:
  - gdb
  - pwndbg
  - pwntools
  - ROPgadget
  - ropper
  - checksec
  - socat
  - nc
  - python3
---

# pwn —— 二进制利用研究环境

## 何时用

1day 复现、漏洞利用开发（exp 编写）、二进制保护分析与调试。样本/目标二进制放进工作区即可在环境内分析。

## 怎么进

```
zhishi env up pwn
zhishi env open <id>       # 或 docker exec -it <container> bash
```

工作区挂载在 `/workspace`。

## 标准工作流

```bash
cd /workspace
checksec --file=./vuln              # ① 看保护：NX/Canary/PIE/RELRO
gdb ./vuln                          # ② pwndbg 自动加载：cyclic 200 定偏移、vmmap 看布局
python3 exp.py                      # ③ pwntools 写 exp
```

pwntools exp 骨架：

```python
from pwn import *
context.log_level = 'debug'
p = process('./vuln')               # 本地调试；远程换 remote('host', port)
# p.sendlineafter(b'>', payload)
p.interactive()
```

- 找 gadget：`ROPgadget --binary ./vuln --ropchain` 或 `ropper -f ./vuln`
- 起服务给 exp 打：`socat TCP-LISTEN:1337,reuseaddr,fork EXEC:./vuln`
- 远程靶机：`nc host port` 或 exp 里 `remote()`——出向网络按任务授权来

## 结果怎么采

exp 脚本、cyclic pattern 分析、崩溃现场（core/寄存器快照）都落 `/workspace`——gdb 里 `generate-core-file` 直接把 core 留在工作区。

## 怎么收尾

`zhishi env down <id>`。调试中想保现场：`docker commit <container> zhishi-pwn-snapshot` 后再 down；下轮 `docker run` 从快照镜像起。有效的工具组合/套路用 `zhishi research log` 记下来，蒸馏弧会沉淀。
