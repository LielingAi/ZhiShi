#!/usr/bin/env bash
# pwn-vm 环境初始化与自检 —— 在 guest（Ubuntu Server）内运行
set -euo pipefail

# pip 用户态安装（PEP 668）落在 ~/.local/bin，非交互 ssh 的 PATH 没有它——
# 自检段直接调 ROPgadget/checksec 会 command not found（2026-08-16 实测）。
export PATH="$HOME/.local/bin:$PATH"

echo "[pwn-vm] installing toolchain via apt..."
sudo apt-get update -qq
sudo apt-get install -y -qq gdb socat netcat-openbsd python3 python3-pip ruby

echo "[pwn-vm] installing python tooling..."
# 大 wheel（pwntools ~13MB）在慢/抖网络下默认 timeout 会 ReadTimeout——
# 加大 timeout/retries，官方源失败回落清华镜像；裸 pip 兜底老 pip（无
# --break-system-packages 的旧版本，PEP 668 在那些系统上也不存在）。
pip3 install --break-system-packages --timeout 120 --retries 10 pwntools ROPgadget 2>/dev/null \
  || pip3 install --break-system-packages --timeout 120 --retries 10 -i https://pypi.tuna.tsinghua.edu.cn/simple pwntools ROPgadget 2>/dev/null \
  || pip3 install --timeout 120 --retries 10 pwntools ROPgadget

echo "[pwn-vm] pwndbg: 按需补装（github 直连在部分网络不可用，不进模板关键路径）"
echo "  补装: git clone --depth 1 https://github.com/pwndbg/pwndbg ~/pwndbg && cd ~/pwndbg && ./setup.sh"

echo "[pwn-vm] installing checksec..."
# rubygems 也可能慢/被墙（2026-08-16 实测挂死 10 分钟撞 SSH_EXEC 超时）——
# 有界等待，装不上不阻塞（checksec 是便利工具，pwntools 自带等价能力）。
sudo timeout 120 gem install checksec 2>/dev/null \
  || pip3 install --break-system-packages --timeout 60 -i https://pypi.tuna.tsinghua.edu.cn/simple checksec-py 2>/dev/null \
  || true

echo "[pwn-vm] checking toolchain..."
gdb --version | head -1
python3 -c "import pwn; print('pwntools ok')"
ROPgadget --version | head -1
gdb -batch -ex "pi import pwndbg" -ex quit 2>&1 | tail -1 || true

echo "[pwn-vm] ready —— 现在做快照：vmrun -T ws snapshot <本VM.vmx> zhishi-clean"
