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

# apt 源回落（1.5.6:默认源不通时切 USTC 镜像——与 gh_dl/pip 镜像回落同惯例;
# 海外网络默认源直通便不触发。22.04=sources.list,24.04=deb822 ubuntu.sources）。
RUN apt-get update -o Acquire::Retries=2 || ( \
      sed -i 's|//archive\.ubuntu\.com|//mirrors.ustc.edu.cn|g; s|//security\.ubuntu\.com|//mirrors.ustc.edu.cn|g' \
        /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources 2>/dev/null; \
      apt-get update \
    )

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-dev \
    nodejs npm \
    curl ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

# garak:LLM 安全扫描器(越狱/注入/泄露探针库,pip 装)
# 1.5.7：24.04 PEP 668 需 --break-system-packages；失败回落清华镜像。
RUN pip3 install --break-system-packages --no-cache-dir garak \
      || pip3 install --break-system-packages --no-cache-dir \
           -i https://pypi.tuna.tsinghua.edu.cn/simple garak

# PyRIT:多轮攻击编排框架(pip 装;新 API 在 pyrit.executor.attack)。
# 注意与已停更的同名 WPA 工具区分——PyPI 现名归 Microsoft PyRIT 所有。
# 1.5.7：同 pip 回落惯例；import 验证移至 setup.sh 构建期自检。
RUN pip3 install --break-system-packages --no-cache-dir pyrit \
      || pip3 install --break-system-packages --no-cache-dir \
           -i https://pypi.tuna.tsinghua.edu.cn/simple pyrit

# promptfoo:LLM eval 框架(npm 装,自定义测试用例；1.5.7：失败回落 npmmirror)
RUN npm install -g promptfoo \
      || npm install -g --registry=https://registry.npmmirror.com promptfoo

# 1.5.7：补构建期自检（此前唯一没有 setup.sh 的配方）
COPY setup.sh /opt/zhishi/setup.sh
RUN chmod +x /opt/zhishi/setup.sh && /opt/zhishi/setup.sh

WORKDIR /workspace
CMD ["tail", "-f", "/dev/null"]
