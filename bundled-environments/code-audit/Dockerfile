FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-dev \
    git curl ca-certificates \
    universal-ctags ripgrep jq less \
 && rm -rf /var/lib/apt/lists/*

# semgrep（静态分析主力；pip 安装,构建期一次到位）
RUN pip3 install --no-cache-dir semgrep

# pip-audit（SCA:依赖漏洞对照）
RUN pip3 install --no-cache-dir pip-audit

# osv-scanner（SCA 主力:多生态依赖漏洞对照;官方 install.sh 取 GitHub
# release,构建期一次到位——与 apt/pip 同级的供应链信任,构建时网络必需）
RUN curl -sSfL https://raw.githubusercontent.com/google/osv-scanner/main/scripts/install.sh | sh

# CodeQL v1 不预装:CLI 下载大且要建数据库——需要时环境内自装
# （见 SKILL.md 的降级路径）,避免镜像膨胀。

WORKDIR /workspace
CMD ["tail", "-f", "/dev/null"]
