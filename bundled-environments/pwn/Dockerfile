FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# 1.5.7 构建期网络回落惯例（7 个 docker 配方统一文本）：GitHub git clone 与
# release/raw 下载直连失败回落 gh-proxy.com（https://gh-proxy.com/<url>，照
# provision.sh 的 gh_dl 形态）；pip install 失败回落清华镜像
# （-i https://pypi.tuna.tsinghua.edu.cn/simple）；npm install -g 失败回落
# npmmirror（--registry=https://registry.npmmirror.com）；gem install 失败回落
# USTC rubygems（--source https://mirrors.ustc.edu.cn/rubygems/）。
# 海外网络直连成功即不触发回落。1.5.7 基座统一 ubuntu 24.04：
# 系统级 pip 一律 --break-system-packages（PEP 668）。

# 1.2.5 选型:删 standalone checksec(pwntools 自带 checksec/cyclic/shellcraft);
# 加 patchelf(pwninit 运行依赖+换 libc)、ruby(one_gadget/seccomp-tools 是 gem)。
# apt 源回落（1.5.6:默认源不通时切 USTC 镜像——与 gh_dl/pip 镜像回落同惯例;
# 海外网络默认源直通便不触发。22.04=sources.list,24.04=deb822 ubuntu.sources）。
RUN apt-get update -o Acquire::Retries=2 || ( \
      sed -i 's|//archive\.ubuntu\.com|//mirrors.ustc.edu.cn|g; s|//security\.ubuntu\.com|//mirrors.ustc.edu.cn|g' \
        /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources 2>/dev/null; \
      apt-get update \
    )

RUN apt-get update && apt-get install -y --no-install-recommends \
    gdb python3 python3-pip python3-dev \
    git curl jq ca-certificates \
    socat netcat-openbsd \
    patchelf ruby \
    file xxd less \
 && rm -rf /var/lib/apt/lists/*

# pwndbg（git clone + 官方 setup.sh，构建期一次装完；1.5.7：clone 加 gh-proxy 回落；
# setup.sh 内部要自己 pip 装 uv 再 uv 装依赖——它内部的 pip/uv 调用不受我们的
# 回落管（2026-09-01 实机：PyPI 不通时 setup.sh 报「uv binary not found」+「No
# matching distribution found for uv」）——失败时带镜像环境变量重试一次）。
# 1.5.8 分层容错：clone 直连+回落都失败降级 WARN（/opt/pwndbg 不存在则 setup.sh
# 也不跑）；clone 成但 setup.sh 裸跑+镜像重试都失败同样降级 WARN——构建继续，
# 缺失由能力探测报 miss，环境内走「补齐环境」重放 provision.sh 补装。
RUN git clone --depth 1 https://github.com/pwndbg/pwndbg /opt/pwndbg \
      || git clone --depth 1 https://gh-proxy.com/https://github.com/pwndbg/pwndbg /opt/pwndbg \
      || echo "[zhishi] WARN: pwndbg 安装失败——构建继续，环境内可用『补齐环境』补装" >&2; \
    if [ -d /opt/pwndbg ]; then \
      cd /opt/pwndbg && ( ./setup.sh \
        || PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
           UV_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
           UV_DEFAULT_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple \
           ./setup.sh \
        || echo "[zhishi] WARN: pwndbg setup.sh 安装失败——构建继续，环境内可用『补齐环境』补装" >&2 ); \
    fi

# pwninit（官方 release 二进制；1.5.7：版本钉 3.3.3 + sha256 校验——官方未发布
# checksums，以下 sha256 为 2026-09-01 下载自算固化；下载加 gh-proxy 回落；
# 1.5.8：下载/校验/安装任一失败降级 WARN，构建继续）
RUN PWNINIT_URL="https://github.com/io12/pwninit/releases/download/3.3.3/pwninit" \
 && ( curl -sSfL "$PWNINIT_URL" -o /usr/local/bin/pwninit \
      || curl -sSfL "https://gh-proxy.com/$PWNINIT_URL" -o /usr/local/bin/pwninit ) \
 && echo "f124b6645b01b0fc4adacabe61438fe73eef517dc3e4696a08e1250a8f47eec3  /usr/local/bin/pwninit" \
      | sha256sum -c - \
 && chmod +x /usr/local/bin/pwninit \
 || echo "[zhishi] WARN: pwninit 安装失败——构建继续，环境内可用『补齐环境』补装" >&2

# libc-database / glibc-all-in-one（换 libc 调试两件套,git clone 即装;
# 实际 libc 包按需 ./get 下载,不进镜像；1.5.7：clone 加 gh-proxy 回落；
# 1.5.8：两段 clone 任一失败降级 WARN，构建继续）
RUN gh_clone() { git clone --depth 1 "$1" "$2" \
      || git clone --depth 1 "https://gh-proxy.com/$1" "$2"; }; \
    gh_clone https://github.com/niklasb/libc-database /opt/libc-database \
 && gh_clone https://github.com/matrix1001/glibc-all-in-one /opt/glibc-all-in-one \
 || echo "[zhishi] WARN: libc-database/glibc-all-in-one 安装失败——构建继续，环境内可用『补齐环境』补装" >&2

COPY setup.sh /opt/zhishi/setup.sh
RUN chmod +x /opt/zhishi/setup.sh && /opt/zhishi/setup.sh

WORKDIR /workspace
CMD ["tail", "-f", "/dev/null"]
