FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

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
