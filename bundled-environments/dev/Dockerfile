FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential clang lldb cmake make \
    python3 python3-pip python3-venv \
    gdb git curl ca-certificates \
    file xxd nano less \
 && rm -rf /var/lib/apt/lists/*

COPY setup.sh /opt/zhishi/setup.sh
RUN chmod +x /opt/zhishi/setup.sh && /opt/zhishi/setup.sh

WORKDIR /workspace
CMD ["tail", "-f", "/dev/null"]
