#!/usr/bin/env bash
# ai-security 环境构建期自检（1.5.7 补齐——此前 7 个 docker 配方里唯一没有
# setup.sh 的；安装段在 Dockerfile，这里逐项验证真实可用）。形态照 dev/setup.sh。
# 1.5.8 分层容错：自检分两类——核心工具（python3/node，apt 基本盘）自检保持
# fatal（失败即非零退出，问题暴露在构建期）；功能工具（garak/pyrit/promptfoo）
# 自检只警告不退出（Dockerfile 侧已降级 WARN，缺失由能力探测报 miss，环境内
# 走「补齐环境」重放 provision.sh 补装）。
set -euo pipefail

echo "[ai-security-env] checking toolchain..."
# 核心（apt 基本盘）自检：fatal
python3 --version
node --version
# 功能工具自检：只警告不退出（WARN 行带工具名，能力探测 miss 时可对照）
python3 -c "import importlib.metadata as m; print('garak', m.version('garak'))" \
  || echo "[zhishi] WARN: garak 自检失败——环境内可用『补齐环境』补装" >&2
python3 -c "from pyrit.executor.attack import PromptSendingAttack; print('pyrit ok')" \
  || echo "[zhishi] WARN: pyrit 自检失败——环境内可用『补齐环境』补装" >&2
promptfoo --version 2>&1 | head -1 \
  || echo "[zhishi] WARN: promptfoo 自检失败——环境内可用『补齐环境』补装" >&2

echo "[ai-security-env] ready"
