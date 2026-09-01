FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# 1.2.5 选型:openjdk 是 Joern 的运行依赖(JRE 17+)
# apt 源回落（1.5.6:默认源不通时切 USTC 镜像——与 gh_dl/pip 镜像回落同惯例;
# 海外网络默认源直通便不触发。22.04=sources.list,24.04=deb822 ubuntu.sources）。
RUN apt-get update -o Acquire::Retries=2 || ( \
      sed -i 's|//archive\.ubuntu\.com|//mirrors.ustc.edu.cn|g; s|//security\.ubuntu\.com|//mirrors.ustc.edu.cn|g' \
        /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources 2>/dev/null; \
      apt-get update \
    )

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-dev \
    git curl unzip ca-certificates \
    openjdk-17-jre-headless \
    universal-ctags ripgrep jq less \
 && rm -rf /var/lib/apt/lists/*

# OpenGrep（静态分析主力,1.2.5 换 Semgrep CE:CE 只剩单文件分析,
# OpenGrep 是功能严格超集、全兼容、无登录无遥测）。
# 装 GitHub release 二进制,不走 pip——PyPI 上的 opengrep 包名曾被抢注,
# 官方分发物就是 release 的 opengrep_manylinux_x86 单文件二进制。
RUN curl -sSfL https://github.com/opengrep/opengrep/releases/latest/download/opengrep_manylinux_x86 \
      -o /usr/local/bin/opengrep \
 && chmod +x /usr/local/bin/opengrep

# Joern（污点传播主力,多语言 CPG）。绕开 joern-install.sh 的交互提示,
# 直接取 release 的 joern-cli 平台包解到 /opt/joern。
# 1.5.5（issue #7）：joern v4.x 起资产改平台分包（joern-cli-<os>-<arch>.zip）,
# 裸 joern-cli.zip 已 404——按 uname -m 选包。
RUN case "$(uname -m)" in \
      aarch64|arm64) JOERN_ASSET=joern-cli-linux-arm64.zip ;; \
      *)             JOERN_ASSET=joern-cli-linux-x86_64.zip ;; \
    esac \
 && curl -sSfL "https://github.com/joernio/joern/releases/latest/download/$JOERN_ASSET" \
      -o /tmp/joern-cli.zip \
 && unzip -q /tmp/joern-cli.zip -d /opt/joern \
 && rm -f /tmp/joern-cli.zip \
 && for b in joern joern-parse joern-scan joern-export joern-slice; do \
      ln -sf "/opt/joern/joern-cli/$b" "/usr/local/bin/$b"; \
    done

# ast-grep（即席 AST 搜索/重写,PyPI 官方包 ast-grep-cli,提供 sg/ast-grep）
# bandit（Python 专项, pip 装）
RUN pip3 install --no-cache-dir ast-grep-cli bandit

# pip-audit（SCA:依赖漏洞对照）
RUN pip3 install --no-cache-dir pip-audit

# osv-scanner（SCA 主力:多生态依赖漏洞对照;官方 install.sh 取 GitHub
# release,构建期一次到位——与 apt/pip 同级的供应链信任,构建时网络必需）
RUN curl -sSfL https://raw.githubusercontent.com/google/osv-scanner/main/scripts/install.sh | sh

# joern-taint.sc:Joern 污点查询模板脚本——把 Joern 从交互式 REPL 变成
# CLI 一把出结果（用法见 SKILL.md 与脚本头注释）
COPY joern-taint.sc /opt/zhishi/joern-taint.sc

COPY setup.sh /opt/zhishi/setup.sh
RUN chmod +x /opt/zhishi/setup.sh && /opt/zhishi/setup.sh

# CodeQL 不预装:CLI 下载大且要建数据库——仅开源靶标条件启用,
# 需要时环境内自装（见 SKILL.md 的降级路径）,避免镜像膨胀。
# registry 规则(opengrep --config p/...)运行时拉取,不随产品分发
# (Semgrep Rules License 红线)。

WORKDIR /workspace
CMD ["tail", "-f", "/dev/null"]
