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
# 1.5.7：下载加 gh-proxy 回落。1.5.8 分层容错：下载/安装失败降级 WARN——
# 构建继续，缺失由能力探测报 miss，环境内走「补齐环境」重放 provision.sh 补装。
RUN OG_URL="https://github.com/opengrep/opengrep/releases/latest/download/opengrep_manylinux_x86" \
 && ( curl -sSfL "$OG_URL" -o /usr/local/bin/opengrep \
      || curl -sSfL "https://gh-proxy.com/$OG_URL" -o /usr/local/bin/opengrep ) \
 && chmod +x /usr/local/bin/opengrep \
 || echo "[zhishi] WARN: opengrep 安装失败——构建继续，环境内可用『补齐环境』补装" >&2

# Joern 不预装（1.5.7 joern provision 化：1.8GB 平台包移出镜像——容器首跑时由
# /opt/zhishi/first-run.sh 按需安装（幂等 + flock 防并发），SKILL.md
# firstRunTools 声明「已登记待装」语义；安装逻辑与 provision.sh 的 joern 段
# 是同一份的两处内嵌，改动须互相同步）
COPY first-run.sh /opt/zhishi/first-run.sh
RUN chmod +x /opt/zhishi/first-run.sh

# ast-grep（即席 AST 搜索/重写,PyPI 官方包 ast-grep-cli,提供 sg/ast-grep）
# bandit（Python 专项, pip 装）
# 1.5.7：24.04 PEP 668 需 --break-system-packages；失败回落清华镜像。
# 1.5.8：回落也失败降级 WARN 不中断构建。
RUN pip3 install --break-system-packages --no-cache-dir ast-grep-cli bandit \
      || pip3 install --break-system-packages --no-cache-dir \
           -i https://pypi.tuna.tsinghua.edu.cn/simple ast-grep-cli bandit \
      || echo "[zhishi] WARN: ast-grep/bandit 安装失败——构建继续，环境内可用『补齐环境』补装" >&2

# pip-audit（SCA:依赖漏洞对照；1.5.7：同上回落惯例；1.5.8：失败降级 WARN）
RUN pip3 install --break-system-packages --no-cache-dir pip-audit \
      || pip3 install --break-system-packages --no-cache-dir \
           -i https://pypi.tuna.tsinghua.edu.cn/simple pip-audit \
      || echo "[zhishi] WARN: pip-audit 安装失败——构建继续，环境内可用『补齐环境』补装" >&2

# osv-scanner（SCA 主力:多生态依赖漏洞对照）。1.5.7：不走官方 install.sh（其内部
# 下载不走镜像,2026-08-29 实机 404）——与 provision.sh 同口径,直接取 release 的
# linux_amd64 二进制 + gh-proxy 回落（gh_dl 形态）；1.5.8：失败降级 WARN
RUN OSV_URL="https://github.com/google/osv-scanner/releases/latest/download/osv-scanner_linux_amd64" \
 && ( curl -sSfL "$OSV_URL" -o /usr/local/bin/osv-scanner \
      || curl -sSfL "https://gh-proxy.com/$OSV_URL" -o /usr/local/bin/osv-scanner ) \
 && chmod +x /usr/local/bin/osv-scanner \
 || echo "[zhishi] WARN: osv-scanner 安装失败——构建继续，环境内可用『补齐环境』补装" >&2

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
