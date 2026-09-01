#!/usr/bin/env bash
# ai-security 环境构建期自检（1.5.7 补齐——此前 7 个 docker 配方里唯一没有
# setup.sh 的；安装段在 Dockerfile，这里逐项验证真实可用，失败即非零退出，
# 让问题暴露在构建期）。形态照 dev/setup.sh。
set -euo pipefail

echo "[ai-security-env] checking toolchain..."
python3 -c "import importlib.metadata as m; print('garak', m.version('garak'))"
python3 -c "from pyrit.executor.attack import PromptSendingAttack; print('pyrit ok')"
promptfoo --version 2>&1 | head -1
python3 --version
node --version

echo "[ai-security-env] ready"
