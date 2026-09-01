#!/usr/bin/env bash
# pwn 裸机/VM 安装脚本（1.5.8 provision.sh——与 Dockerfile 功能工具段 + setup.sh
# 安装段同源，服务「docker 配方绑定到 VM/裸机」与容器内「补齐环境」链路）。
# 已装跳过（command -v / 路径守卫），可反复重放；GitHub 走 gh_dl 镜像回落、
# pip 回落清华、gem 回落 USTC（1.5.7 惯例）；非核心失败 WARN 不阻塞，重放即补。
#
# 同步点（1.5.8）：本脚本各安装段与 Dockerfile/setup.sh 是同一份逻辑的两处
# 内嵌（本脚本走 base64 传输必须自包含，无法 source 共享文件）——改一处必须
# 同步另一处。
#
# 提权兼容（1.5.8）：docker 容器内是 root（容器里无 sudo），VM/裸机为非
# root + 免密 sudo——按 id -u 判定 $SUDO。脚本内不出现字面「sudo」调用，
# environment/setup 端点的 sudo免密预检（脚本含「sudo」字样才触发）因此
# 不拦容器场景；VM 侧若免密未配，会在首个 $SUDO 命令处失败，日志尾部可见。
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"

if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi

# GitHub 下载带公共镜像回落（gh_dl 形态，1.4.9 实机惯例）。
gh_dl() { # gh_dl <release-url> <输出文件> <超时秒>
  local url="$1" out="$2" t="$3"
  curl -sSfL --max-time "$t" "$url" -o "$out" 2>/dev/null \
    || curl -sSfL --max-time "$t" "https://gh-proxy.com/$url" -o "$out" 2>/dev/null
}

echo "[pwn/provision] installing base toolchain via apt..."
$SUDO apt-get update -qq
$SUDO apt-get install -y -qq gdb python3 python3-pip python3-dev \
  git curl jq ca-certificates socat netcat-openbsd patchelf ruby file xxd less

# pwndbg（同步 Dockerfile pwndbg 段：clone 直连→gh-proxy 回落；官方 setup.sh
# 裸跑→带清华镜像环境变量重试（它内部的 pip/uv 调用不受外部回落管，1.5.7
# 实机教训）→都失败 WARN）。已 clone 但 setup.sh 未跑成的半装态（无 .venv）
# 重放时会补跑 setup.sh。
if [ -d /opt/pwndbg ]; then
  echo "[pwn/provision] pwndbg 仓库已在，跳过 clone"
else
  $SUDO git clone --depth 1 https://github.com/pwndbg/pwndbg /opt/pwndbg \
    || $SUDO git clone --depth 1 https://gh-proxy.com/https://github.com/pwndbg/pwndbg /opt/pwndbg \
    || echo "[pwn/provision] WARN: pwndbg clone 失败——可重放本脚本补装" >&2
fi
if [ -d /opt/pwndbg ] && [ ! -d /opt/pwndbg/.venv ]; then
  ( cd /opt/pwndbg && $SUDO ./setup.sh ) \
    || ( cd /opt/pwndbg && $SUDO env \
         PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
         UV_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
         UV_DEFAULT_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple \
         ./setup.sh ) \
    || echo "[pwn/provision] WARN: pwndbg setup.sh 失败——可重放本脚本补装" >&2
fi

# pwninit（同步 Dockerfile pwninit 段：官方 release 钉 3.3.3 + sha256 固化校验）
if ! command -v pwninit >/dev/null 2>&1; then
  echo "[pwn/provision] installing pwninit..."
  gh_dl "https://github.com/io12/pwninit/releases/download/3.3.3/pwninit" /tmp/pwninit 300 \
    && echo "f124b6645b01b0fc4adacabe61438fe73eef517dc3e4696a08e1250a8f47eec3  /tmp/pwninit" \
         | sha256sum -c - \
    && chmod +x /tmp/pwninit \
    && $SUDO install -m 0755 /tmp/pwninit /usr/local/bin/pwninit \
    && rm -f /tmp/pwninit \
    || echo "[pwn/provision] WARN: pwninit 装不上——可重放本脚本或环境内手工补" >&2
else
  echo "[pwn/provision] pwninit 已装，跳过"
fi

# libc-database / glibc-all-in-one（同步 Dockerfile 同名段：clone 即装，
# gh-proxy 回落；实际 libc 包按需 ./get 下载，不在此装）
if [ -d /opt/libc-database ]; then
  echo "[pwn/provision] libc-database 已在，跳过"
else
  $SUDO git clone --depth 1 https://github.com/niklasb/libc-database /opt/libc-database \
    || $SUDO git clone --depth 1 https://gh-proxy.com/https://github.com/niklasb/libc-database /opt/libc-database \
    || echo "[pwn/provision] WARN: libc-database clone 失败——可重放本脚本补装" >&2
fi
if [ -d /opt/glibc-all-in-one ]; then
  echo "[pwn/provision] glibc-all-in-one 已在，跳过"
else
  $SUDO git clone --depth 1 https://github.com/matrix1001/glibc-all-in-one /opt/glibc-all-in-one \
    || $SUDO git clone --depth 1 https://gh-proxy.com/https://github.com/matrix1001/glibc-all-in-one /opt/glibc-all-in-one \
    || echo "[pwn/provision] WARN: glibc-all-in-one clone 失败——可重放本脚本补装" >&2
fi

# pwntools / ROPgadget（同步 setup.sh pip 段：清华镜像回落；24.04 PEP 668 需
# --break-system-packages）
if python3 -c "import pwn" >/dev/null 2>&1 && command -v ROPgadget >/dev/null 2>&1; then
  echo "[pwn/provision] pwntools/ROPgadget 已装，跳过"
else
  echo "[pwn/provision] installing pwntools/ROPgadget..."
  pip3 install --break-system-packages --timeout 120 --retries 10 pwntools ROPgadget 2>/dev/null \
    || pip3 install --break-system-packages --timeout 120 --retries 10 \
         -i https://pypi.tuna.tsinghua.edu.cn/simple pwntools ROPgadget 2>/dev/null \
    || echo "[pwn/provision] WARN: pwntools/ROPgadget 装不上——可重放本脚本或环境内手工补" >&2
fi

# seccomp-tools / one_gadget（同步 setup.sh gem 段：USTC rubygems 回落）
if command -v seccomp-tools >/dev/null 2>&1 && command -v one_gadget >/dev/null 2>&1; then
  echo "[pwn/provision] seccomp-tools/one_gadget 已装，跳过"
else
  echo "[pwn/provision] installing seccomp-tools/one_gadget..."
  $SUDO gem install seccomp-tools one_gadget 2>/dev/null \
    || $SUDO gem install --source https://mirrors.ustc.edu.cn/rubygems/ seccomp-tools one_gadget 2>/dev/null \
    || echo "[pwn/provision] WARN: seccomp-tools/one_gadget 装不上——可重放本脚本或环境内手工补" >&2
fi

echo "[pwn/provision] checking toolchain..."
gdb --version 2>&1 | head -1 || true
python3 -c "import pwn; print('pwntools ok')" 2>&1 | head -1 || true
ROPgadget --version 2>&1 | head -1 || true
pwninit --version 2>&1 | head -1 || true
seccomp-tools --version 2>&1 | head -1 || true
one_gadget --version 2>&1 | head -1 || true

echo "[pwn/provision] ready"
