#!/usr/bin/env bash
# fuzz 裸机/VM 安装脚本（1.4.10 provision.sh，1.5.8 提权兼容化——与 Dockerfile
# apt 段同源，服务「docker 配方绑定到 VM/裸机」与容器内「补齐环境」链路）。
# 纯 apt 系，天然幂等；已装守卫只是省时间。
#
# 提权兼容（1.5.8）：docker 容器内是 root（容器里无 sudo），VM/裸机为非
# root + 免密 sudo——按 id -u 判定 $SUDO。脚本内不出现字面「sudo」调用，
# environment/setup 端点的 sudo免密预检（脚本含「sudo」字样才触发）因此
# 不拦容器场景；VM 侧若免密未配，会在首个 $SUDO 命令处失败，日志尾部可见。
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"

if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi

echo "[fuzz/provision] installing toolchain via apt..."
$SUDO apt-get update -qq
$SUDO apt-get install -y -qq afl++ clang llvm build-essential \
  python3 python3-pip gdb git curl ca-certificates file xxd less

echo "[fuzz/provision] checking toolchain..."
afl-fuzz -h 2>&1 | head -1 || true
clang --version | head -1 || true
gdb --version | head -1 || true

# 插桩编译自检（与 fuzz-vm setup.sh 同款）：最小程序过一遍 afl-clang-fast。
if command -v afl-clang-fast >/dev/null 2>&1; then
  cat > /tmp/zhishi-afl-selfcheck.c <<'EOF'
#include <stdio.h>
int main(void){ char buf[8]; if (fgets(buf, sizeof buf, stdin)) puts(buf); return 0; }
EOF
  afl-clang-fast -g -O1 /tmp/zhishi-afl-selfcheck.c -o /tmp/zhishi-afl-selfcheck \
    && echo hi | /tmp/zhishi-afl-selfcheck >/dev/null \
    && echo "[fuzz/provision] afl-clang-fast 插桩自检通过" \
    || echo "[fuzz/provision] WARN: 插桩自检失败"
  rm -f /tmp/zhishi-afl-selfcheck /tmp/zhishi-afl-selfcheck.c
fi

echo "[fuzz/provision] ready"
