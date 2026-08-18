FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    afl++ clang build-essential \
    python3 python3-pip \
    gdb git curl ca-certificates \
    file xxd less \
 && rm -rf /var/lib/apt/lists/*

ENV AFL_SKIP_CPUFREQ=1 \
    AFL_I_DONT_CARE_ABOUT_MISSING_CRASHES=1 \
    AFL_NO_AFFINITY=1

COPY setup.sh /opt/zhishi/setup.sh
RUN chmod +x /opt/zhishi/setup.sh && /opt/zhishi/setup.sh

WORKDIR /workspace
CMD ["tail", "-f", "/dev/null"]
