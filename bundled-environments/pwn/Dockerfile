FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    gdb python3 python3-pip python3-dev \
    git curl ca-certificates \
    socat netcat-openbsd checksec \
    file xxd less \
 && rm -rf /var/lib/apt/lists/*

# pwndbg（git clone + 官方 setup.sh，构建期一次装完）
RUN git clone --depth 1 https://github.com/pwndbg/pwndbg /opt/pwndbg \
 && cd /opt/pwndbg && ./setup.sh

COPY setup.sh /opt/zhishi/setup.sh
RUN chmod +x /opt/zhishi/setup.sh && /opt/zhishi/setup.sh

WORKDIR /workspace
CMD ["tail", "-f", "/dev/null"]
