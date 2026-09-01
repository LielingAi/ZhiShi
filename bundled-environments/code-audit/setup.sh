#!/usr/bin/env bash
# code-audit 环境初始化与自检
set -euo pipefail

echo "[code-audit-env] checking toolchain..."
opengrep --version
sg --version
bandit --version 2>&1 | head -1
pip-audit --version 2>&1 | head -1
osv-scanner --version 2>&1 | head -1 || true
java -version 2>&1 | head -1
# 1.5.7：joern 移出镜像（provision 化）——构建期未安装，首跑由
# /opt/zhishi/first-run.sh 装；此处只探测不报错
joern --version 2>&1 | head -1 || true
joern-parse --help 2>&1 | head -1 || true
rg --version | head -1
ctags --version | head -1

echo "[code-audit-env] ready"
