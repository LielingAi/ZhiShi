FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# 1.2.5 选型:删 standalone checksec(pwntools 自带 checksec/cyclic/shellcraft);
# 加 patchelf(pwninit 运行依赖+换 libc)、ruby(one_gadget/seccomp-tools 是 gem)。
RUN apt-get update && apt-get install -y --no-install-recommends \
    gdb python3 python3-pip python3-dev \
    git curl jq ca-certificates \
    socat netcat-openbsd \
    patchelf ruby \
    file xxd less \
 && rm -rf /var/lib/apt/lists/*

# pwndbg（git clone + 官方 setup.sh，构建期一次装完）
RUN git clone --depth 1 https://github.com/pwndbg/pwndbg /opt/pwndbg \
 && cd /opt/pwndbg && ./setup.sh

# pwninit（官方 release 二进制,GitHub API 取最新版）
RUN PWNINIT_URL=$(curl -sSf https://api.github.com/repos/io12/pwninit/releases/latest \
      | jq -r '.assets[].browser_download_url | select(test("pwninit$"))' | head -1) \
 && curl -sSfL "$PWNINIT_URL" -o /usr/local/bin/pwninit \
 && chmod +x /usr/local/bin/pwninit

# libc-database / glibc-all-in-one（换 libc 调试两件套,git clone 即装;
# 实际 libc 包按需 ./get 下载,不进镜像）
RUN git clone --depth 1 https://github.com/niklasb/libc-database /opt/libc-database \
 && git clone --depth 1 https://github.com/matrix1001/glibc-all-in-one /opt/glibc-all-in-one

COPY setup.sh /opt/zhishi/setup.sh
RUN chmod +x /opt/zhishi/setup.sh && /opt/zhishi/setup.sh

WORKDIR /workspace
CMD ["tail", "-f", "/dev/null"]
