FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    openjdk-21-jre-headless \
    python3 python3-pip \
    gdb binutils file xxd \
    curl wget unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY setup.sh /opt/zhishi/setup.sh
RUN chmod +x /opt/zhishi/setup.sh && /opt/zhishi/setup.sh

WORKDIR /workspace
CMD ["tail", "-f", "/dev/null"]
