#!/usr/bin/env bash
# code-audit 裸机/VM 安装脚本（1.4.9 provision.sh——与 Dockerfile 安装段同源，
# 服务「docker 配方绑定到 VM/裸机」的补齐链路；docker 环境内不需要它——
# Dockerfile 已装）。已装跳过（command -v 守卫），可反复重放；官方源失败
# 回落清华镜像；非核心工具装不上不阻塞（环境内可按 SKILL.md 降级路径手工补）。
#
# 需要：bash + sudo 免密（environment/setup 端点会先做 sudo -n 预检）。
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"

# GitHub 下载带公共镜像回落（2026-08-29 实机：直连 joern-cli.zip 300s 只下了
# 5.7/46MB、osv-scanner install.sh 404——pypi 段有清华镜像回落所以成了，
# GitHub 段没有所以全挂。教训同源：pentest-vm setup.sh 的镜像回落惯例）。
gh_dl() { # gh_dl <release-url> <输出文件> <超时秒>
  local url="$1" out="$2" t="$3"
  curl -sSfL --max-time "$t" "$url" -o "$out" 2>/dev/null \
    || curl -sSfL --max-time "$t" "https://gh-proxy.com/$url" -o "$out" 2>/dev/null
}

echo "[code-audit/provision] installing base toolchain via apt..."
sudo apt-get update -qq
sudo apt-get install -y -qq python3 python3-pip git curl unzip ca-certificates \
  openjdk-17-jre-headless universal-ctags ripgrep jq less

# OpenGrep（静态分析主力，1.2.5 选型：Semgrep CE 只剩单文件分析，OpenGrep
# 是功能严格超集）。官方 release 单文件二进制，不走 pip（PyPI 包名曾被抢注）。
if ! command -v opengrep >/dev/null 2>&1; then
  echo "[code-audit/provision] installing opengrep..."
  gh_dl https://github.com/opengrep/opengrep/releases/latest/download/opengrep_manylinux_x86 /tmp/opengrep 300 \
    && chmod +x /tmp/opengrep \
    && sudo install -m 0755 /tmp/opengrep /usr/local/bin/opengrep \
    && rm -f /tmp/opengrep \
    || echo "[code-audit/provision] WARN: opengrep 装不上，环境内手工补"
else
  echo "[code-audit/provision] opengrep 已装，跳过"
fi

# Joern（污点传播主力，多语言 CPG）。绕开 joern-install.sh 交互提示，
# 直接取 release 的 joern-cli 平台包解到 /opt/joern。
# 1.5.5（issue #7）：joern v4.x 起 release 资产改平台分包
# （joern-cli-<os>-<arch>.zip），裸 joern-cli.zip 已不存在（404）——
# 按 uname -m 选包。
if ! command -v joern >/dev/null 2>&1; then
  echo "[code-audit/provision] installing joern..."
  case "$(uname -m)" in
    aarch64|arm64) JOERN_ASSET=joern-cli-linux-arm64.zip ;;
    *)             JOERN_ASSET=joern-cli-linux-x86_64.zip ;;
  esac
  gh_dl "https://github.com/joernio/joern/releases/latest/download/$JOERN_ASSET" /tmp/joern-cli.zip 900 \
    && sudo rm -rf /opt/joern/joern-cli \
    && sudo unzip -q /tmp/joern-cli.zip -d /opt/joern \
    && rm -f /tmp/joern-cli.zip \
    && for b in joern joern-parse joern-scan joern-export joern-slice; do \
         sudo ln -sf "/opt/joern/joern-cli/$b" "/usr/local/bin/$b"; \
       done \
    || echo "[code-audit/provision] WARN: joern 装不上，环境内手工补"
else
  echo "[code-audit/provision] joern 已装，跳过"
fi

# ast-grep（sg：即席 AST 搜索/重写）+ bandit（Python 专项）+ pip-audit（SCA）。
# 大 wheel 慢网有界等待，官方源失败回落清华镜像。
echo "[code-audit/provision] installing python tooling (ast-grep/bandit/pip-audit)..."
pip3 install --break-system-packages --timeout 120 --retries 10 ast-grep-cli bandit pip-audit 2>/dev/null \
  || pip3 install --break-system-packages --timeout 120 --retries 10 -i https://pypi.tuna.tsinghua.edu.cn/simple ast-grep-cli bandit pip-audit 2>/dev/null \
  || pip3 install --timeout 120 --retries 10 ast-grep-cli bandit pip-audit

# osv-scanner（SCA 主力：多生态依赖漏洞对照）。不走官方 install.sh（其内部
# 下载不走镜像，2026-08-29 实机 404）——直接取 release 的 linux_amd64 二进制。
if ! command -v osv-scanner >/dev/null 2>&1; then
  echo "[code-audit/provision] installing osv-scanner..."
  gh_dl https://github.com/google/osv-scanner/releases/latest/download/osv-scanner_linux_amd64 /tmp/osv-scanner 300 \
    && chmod +x /tmp/osv-scanner \
    && sudo install -m 0755 /tmp/osv-scanner /usr/local/bin/osv-scanner \
    && rm -f /tmp/osv-scanner \
    || echo "[code-audit/provision] WARN: osv-scanner 装不上，环境内手工补"
else
  echo "[code-audit/provision] osv-scanner 已装，跳过"
fi

echo "[code-audit/provision] checking toolchain..."
opengrep --version 2>&1 | head -1 || true
sg --version 2>&1 | head -1 || true
bandit --version 2>&1 | head -1 || true
pip-audit --version 2>&1 | head -1 || true
osv-scanner --version 2>&1 | head -1 || true
java -version 2>&1 | head -1 || true
joern --version 2>&1 | head -1 || true

echo "[code-audit/provision] ready"
