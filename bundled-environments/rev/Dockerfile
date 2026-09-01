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

# 1.2.5 选型:加 radare2(快速静态面/脚本化,r2 是 Ghidra 之外的快手件)
# apt 源回落（1.5.6:默认源不通时切 USTC 镜像——与 gh_dl/pip 镜像回落同惯例;
# 海外网络默认源直通便不触发。22.04=sources.list,24.04=deb822 ubuntu.sources）。
RUN apt-get update -o Acquire::Retries=2 || ( \
      sed -i 's|//archive\.ubuntu\.com|//mirrors.ustc.edu.cn|g; s|//security\.ubuntu\.com|//mirrors.ustc.edu.cn|g' \
        /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources 2>/dev/null; \
      apt-get update \
    )

RUN apt-get update && apt-get install -y --no-install-recommends \
    openjdk-21-jre-headless \
    python3 python3-pip \
    gdb binutils radare2 file xxd \
    curl wget unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# ghidriff(pyhidra)需要定位 Ghidra 安装目录
ENV GHIDRA_INSTALL_DIR=/opt/ghidra

COPY setup.sh /opt/zhishi/setup.sh
RUN chmod +x /opt/zhishi/setup.sh && /opt/zhishi/setup.sh

WORKDIR /workspace
CMD ["tail", "-f", "/dev/null"]
