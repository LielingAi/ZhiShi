FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# 1.2.5 选型:加 radare2(快速静态面/脚本化,r2 是 Ghidra 之外的快手件)
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
