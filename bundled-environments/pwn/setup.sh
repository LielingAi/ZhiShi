#!/usr/bin/env bash
# pwn 环境初始化与自检
set -euo pipefail

echo "[pwn-env] installing python tooling..."
# 1.2.5 选型:删 ropper(停滞+与 ROPgadget 冗余)
pip3 install --no-cache-dir pwntools ROPgadget

echo "[pwn-env] installing ruby tooling..."
gem install seccomp-tools one_gadget

echo "[pwn-env] checking toolchain..."
gdb --version | head -1
python3 -c "import pwn; print('pwntools', pwn.__version__ if hasattr(pwn, '__version__') else 'ok')"
ROPgadget --version | head -1
checksec --version | head -1    # pwntools 自带的 checksec
cyclic --help 2>&1 | head -1 || true
patchelf --version | head -1
pwninit --version | head -1
seccomp-tools --version 2>&1 | head -1
one_gadget --version 2>&1 | head -1
ls /opt/libc-database /opt/glibc-all-in-one >/dev/null
gdb -batch -ex "pi import pwndbg" -ex quit 2>&1 | tail -1 || true

echo "[pwn-env] ready"
