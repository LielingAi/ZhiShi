#!/usr/bin/env bash
# ai-security 裸机/VM 安装脚本（1.5.8 provision.sh——与 Dockerfile 功能工具段
# 同源，服务「docker 配方绑定到 VM/裸机」与容器内「补齐环境」链路）。
# 已装跳过（command -v / import 守卫），可反复重放；pip 回落清华、npm 回落
# npmmirror（1.5.7 惯例）；非核心失败 WARN 不阻塞，重放即补。
#
# 同步点（1.5.8）：本脚本 garak/pyrit/promptfoo 段与 Dockerfile 是同一份逻辑
# 的两处内嵌（本脚本走 base64 传输必须自包含，无法 source 共享文件）——
# 改一处必须同步另一处。
#
# 提权兼容（1.5.8）：docker 容器内是 root（容器里无 sudo），VM/裸机为非
# root + 免密 sudo——按 id -u 判定 $SUDO。脚本内不出现字面「sudo」调用，
# environment/setup 端点的 sudo免密预检（脚本含「sudo」字样才触发）因此
# 不拦容器场景；VM 侧若免密未配，会在首个 $SUDO 命令处失败，日志尾部可见。
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"

if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi

echo "[ai-security/provision] installing base toolchain via apt..."
$SUDO apt-get update -qq
$SUDO apt-get install -y -qq python3 python3-pip python3-dev \
  nodejs npm curl ca-certificates git

# garak（同步 Dockerfile garak 段：LLM 安全扫描器，pip 装 + 清华镜像回落；
# 24.04 PEP 668 需 --break-system-packages）
if python3 -c "import importlib.metadata as m; m.version('garak')" >/dev/null 2>&1; then
  echo "[ai-security/provision] garak 已装，跳过"
else
  echo "[ai-security/provision] installing garak..."
  pip3 install --break-system-packages --timeout 120 --retries 10 garak 2>/dev/null \
    || pip3 install --break-system-packages --timeout 120 --retries 10 \
         -i https://pypi.tuna.tsinghua.edu.cn/simple garak 2>/dev/null \
    || echo "[ai-security/provision] WARN: garak 装不上——可重放本脚本或环境内手工补" >&2
fi

# PyRIT（同步 Dockerfile pyrit 段：多轮攻击编排框架；注意与已停更的同名 WPA
# 工具区分——PyPI 现名归 Microsoft PyRIT 所有）
if python3 -c "from pyrit.executor.attack import PromptSendingAttack" >/dev/null 2>&1; then
  echo "[ai-security/provision] pyrit 已装，跳过"
else
  echo "[ai-security/provision] installing pyrit..."
  pip3 install --break-system-packages --timeout 120 --retries 10 pyrit 2>/dev/null \
    || pip3 install --break-system-packages --timeout 120 --retries 10 \
         -i https://pypi.tuna.tsinghua.edu.cn/simple pyrit 2>/dev/null \
    || echo "[ai-security/provision] WARN: pyrit 装不上——可重放本脚本或环境内手工补" >&2
fi

# promptfoo（同步 Dockerfile promptfoo 段：npm 装 + npmmirror 回落；npm -g
# 需要提权）
if ! command -v promptfoo >/dev/null 2>&1; then
  echo "[ai-security/provision] installing promptfoo..."
  $SUDO npm install -g promptfoo 2>/dev/null \
    || $SUDO npm install -g --registry=https://registry.npmmirror.com promptfoo 2>/dev/null \
    || echo "[ai-security/provision] WARN: promptfoo 装不上——可重放本脚本或环境内手工补" >&2
else
  echo "[ai-security/provision] promptfoo 已装，跳过"
fi

echo "[ai-security/provision] checking toolchain..."
python3 --version 2>&1 || true
node --version 2>&1 || true
python3 -c "import importlib.metadata as m; print('garak', m.version('garak'))" 2>&1 || true
python3 -c "from pyrit.executor.attack import PromptSendingAttack; print('pyrit ok')" 2>&1 || true
promptfoo --version 2>&1 | head -1 || true

echo "[ai-security/provision] ready"
