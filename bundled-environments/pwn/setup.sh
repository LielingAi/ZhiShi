#!/usr/bin/env bash
# pwn 环境初始化与自检
set -euo pipefail

echo "[pwn-env] installing python tooling..."
pip3 install --no-cache-dir pwntools ROPgadget ropper

echo "[pwn-env] checking toolchain..."
gdb --version | head -1
python3 -c "import pwn; print('pwntools', pwn.__version__ if hasattr(pwn, '__version__') else 'ok')"
ROPgadget --version | head -1
checksec --version | head -1
gdb -batch -ex "pi import pwndbg" -ex quit 2>&1 | tail -1 || true

echo "[pwn-env] ready"
