#!/usr/bin/env bash
# pwn 环境初始化与自检
# 1.5.8 分层容错：pip/gem 功能工具安装失败降级 WARN 不中断构建（缺失由能力
# 探测报 miss，环境内走「补齐环境」重放 provision.sh 补装）；自检分两类——
# 核心工具（apt 基本盘：gdb/python3/patchelf 等）自检保持 fatal，功能工具
# 自检只警告不退出。
set -euo pipefail

echo "[pwn-env] installing python tooling..."
# 1.2.5 选型:删 ropper(停滞+与 ROPgadget 冗余)
# 1.5.7：24.04 PEP 668 系统级 pip 需 --break-system-packages；失败回落清华镜像。
# 1.5.8：回落也失败降级 WARN，不中断构建。
pip3 install --break-system-packages --no-cache-dir pwntools ROPgadget \
  || pip3 install --break-system-packages --no-cache-dir \
       -i https://pypi.tuna.tsinghua.edu.cn/simple pwntools ROPgadget \
  || echo "[zhishi] WARN: pwntools/ROPgadget 安装失败——构建继续，环境内可用『补齐环境』补装" >&2

echo "[pwn-env] installing ruby tooling..."
# 1.5.7：gem 失败回落 USTC rubygems 镜像。1.5.8：回落也失败降级 WARN。
gem install seccomp-tools one_gadget \
  || gem install --source https://mirrors.ustc.edu.cn/rubygems/ seccomp-tools one_gadget \
  || echo "[zhishi] WARN: seccomp-tools/one_gadget 安装失败——构建继续，环境内可用『补齐环境』补装" >&2

echo "[pwn-env] checking toolchain..."
# 核心（apt 基本盘）自检：失败即非零退出，构建期暴露问题
gdb --version | head -1
patchelf --version | head -1
python3 --version
# 功能工具自检：只警告不退出（1.5.8——降级未装/装了但装坏都不中断构建，
# WARN 行带工具名，能力探测 miss 时可对照）
python3 -c "import pwn; print('pwntools', pwn.__version__ if hasattr(pwn, '__version__') else 'ok')" \
  || echo "[zhishi] WARN: pwntools 自检失败——环境内可用『补齐环境』补装" >&2
ROPgadget --version | head -1 \
  || echo "[zhishi] WARN: ROPgadget 自检失败——环境内可用『补齐环境』补装" >&2
checksec --version | head -1 \
  || echo "[zhishi] WARN: checksec(pwntools) 自检失败——环境内可用『补齐环境』补装" >&2
cyclic --help 2>&1 | head -1 \
  || echo "[zhishi] WARN: cyclic(pwntools) 自检失败——环境内可用『补齐环境』补装" >&2
pwninit --version | head -1 \
  || echo "[zhishi] WARN: pwninit 自检失败——环境内可用『补齐环境』补装" >&2
seccomp-tools --version 2>&1 | head -1 \
  || echo "[zhishi] WARN: seccomp-tools 自检失败——环境内可用『补齐环境』补装" >&2
one_gadget --version 2>&1 | head -1 \
  || echo "[zhishi] WARN: one_gadget 自检失败——环境内可用『补齐环境』补装" >&2
ls /opt/libc-database /opt/glibc-all-in-one >/dev/null \
  || echo "[zhishi] WARN: libc-database/glibc-all-in-one 缺失——环境内可用『补齐环境』补装" >&2
[ -d /opt/pwndbg ] \
  || echo "[zhishi] WARN: pwndbg 缺失——环境内可用『补齐环境』补装" >&2
gdb -batch -ex "pi import pwndbg" -ex quit 2>&1 | tail -1 || true

echo "[pwn-env] ready"
