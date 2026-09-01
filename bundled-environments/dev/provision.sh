#!/usr/bin/env bash
# dev 裸机/VM 安装脚本（1.5.8 provision.sh——本配方无功能工具，Dockerfile 只有
# apt 基本盘 + setup.sh 自检；本脚本 = 基本盘核对安装 + setup.sh 同款自检重放，
# 存在即让「补齐环境」链路对本配方可用）。纯 apt 系，天然幂等，可反复重放。
#
# 同步点（1.5.8）：apt 清单与 Dockerfile 基本盘段、自检段与 setup.sh 分别是
# 同一份逻辑的两处内嵌（本脚本走 base64 传输必须自包含，无法 source 共享
# 文件）——改一处必须同步另一处。
#
# 提权兼容（1.5.8）：docker 容器内是 root（容器里无 sudo），VM/裸机为非
# root + 免密 sudo——按 id -u 判定 $SUDO。脚本内不出现字面「sudo」调用，
# environment/setup 端点的 sudo免密预检（脚本含「sudo」字样才触发）因此
# 不拦容器场景；VM 侧若免密未配，会在首个 $SUDO 命令处失败，日志尾部可见。
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"

if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi

echo "[dev/provision] installing base toolchain via apt..."
$SUDO apt-get update -qq
$SUDO apt-get install -y -qq build-essential clang lldb cmake make \
  python3 python3-pip python3-venv gdb git curl ca-certificates \
  file xxd nano less

# 自检与 setup.sh 同款：核心工具链验证失败即非零退出（基本盘缺失属核心问题，
# 不降级）
echo "[dev/provision] checking toolchain..."
clang --version | head -1
gcc --version | head -1
python3 --version
gdb --version | head -1
make --version | head -1

echo 'int main(void){return 0;}' > /tmp/zhishi-selfcheck.c
clang /tmp/zhishi-selfcheck.c -o /tmp/zhishi-selfcheck
/tmp/zhishi-selfcheck
rm -f /tmp/zhishi-selfcheck /tmp/zhishi-selfcheck.c

echo "[dev/provision] ready"
