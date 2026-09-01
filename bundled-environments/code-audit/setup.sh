#!/usr/bin/env bash
# code-audit 环境初始化与自检
# 1.5.8 分层容错：自检分两类——核心工具（apt 基本盘：java/rg/ctags）自检保持
# fatal（失败即非零退出，构建期暴露问题）；功能工具自检只警告不退出
#（Dockerfile 侧已降级 WARN，缺失由能力探测报 miss，环境内走「补齐环境」
# 重放 provision.sh 补装）。
set -euo pipefail

echo "[code-audit-env] checking toolchain..."
# 核心（apt 基本盘）自检：fatal
java -version 2>&1 | head -1
rg --version | head -1
ctags --version | head -1
# 功能工具自检：只警告不退出（WARN 行带工具名，能力探测 miss 时可对照）
opengrep --version \
  || echo "[zhishi] WARN: opengrep 自检失败——环境内可用『补齐环境』补装" >&2
sg --version \
  || echo "[zhishi] WARN: ast-grep(sg) 自检失败——环境内可用『补齐环境』补装" >&2
bandit --version 2>&1 | head -1 \
  || echo "[zhishi] WARN: bandit 自检失败——环境内可用『补齐环境』补装" >&2
pip-audit --version 2>&1 | head -1 \
  || echo "[zhishi] WARN: pip-audit 自检失败——环境内可用『补齐环境』补装" >&2
osv-scanner --version 2>&1 | head -1 \
  || echo "[zhishi] WARN: osv-scanner 自检失败——环境内可用『补齐环境』补装" >&2
# 1.5.7：joern 移出镜像（provision 化）——构建期未安装，首跑由
# /opt/zhishi/first-run.sh 装；此处只探测不报错
joern --version 2>&1 | head -1 || true
joern-parse --help 2>&1 | head -1 || true

echo "[code-audit-env] ready"
