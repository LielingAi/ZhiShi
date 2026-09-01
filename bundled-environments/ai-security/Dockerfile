FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

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
RUN pip3 install --no-cache-dir garak

# PyRIT:多轮攻击编排框架(pip 装;新 API 在 pyrit.executor.attack)。
# 注意与已停更的同名 WPA 工具区分——PyPI 现名归 Microsoft PyRIT 所有。
RUN pip3 install --no-cache-dir pyrit \
 && python3 -c "from pyrit.executor.attack import PromptSendingAttack; print('pyrit ok')"

# promptfoo:LLM eval 框架(npm 装,自定义测试用例)
RUN npm install -g promptfoo

WORKDIR /workspace
CMD ["tail", "-f", "/dev/null"]
