FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# apt 源回落（1.5.6:默认源不通时切 USTC 镜像——与 gh_dl/pip 镜像回落同惯例;
# 海外网络默认源直通便不触发。22.04=sources.list,24.04=deb822 ubuntu.sources）。
RUN apt-get update -o Acquire::Retries=2 || ( \
      sed -i 's|//archive\.ubuntu\.com|//mirrors.ustc.edu.cn|g; s|//security\.ubuntu\.com|//mirrors.ustc.edu.cn|g' \
        /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources 2>/dev/null; \
      apt-get update \
    )

RUN apt-get update && apt-get install -y --no-install-recommends \
    afl++ clang llvm build-essential \
    python3 python3-pip \
    gdb git curl ca-certificates \
    file xxd less \
 && rm -rf /var/lib/apt/lists/*

ENV AFL_SKIP_CPUFREQ=1 \
    AFL_I_DONT_CARE_ABOUT_MISSING_CRASHES=1 \
    AFL_NO_AFFINITY=1

COPY setup.sh /opt/zhishi/setup.sh
COPY examples/libfuzzer-harness.c /opt/zhishi/examples/libfuzzer-harness.c
RUN chmod +x /opt/zhishi/setup.sh && /opt/zhishi/setup.sh

WORKDIR /workspace
CMD ["tail", "-f", "/dev/null"]
