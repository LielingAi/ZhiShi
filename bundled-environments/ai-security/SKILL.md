---
name: ai-security
description: AI 安全研究环境——对 LLM 端点的安全测试环境。任务涉及越狱测试、提示注入、数据泄露探针、模型偏见/幻觉评测时使用。内置 garak（越狱/注入探针扫描器）+ promptfoo（自定义 eval 框架）+ PyRIT（多轮攻击编排,Python 库,新 API 在 pyrit.executor.attack,无 CLI——经 python3 驱动）。Gandalf 作判分靶场。
base: docker
tools:
  - garak
  - promptfoo
  - python3
  - node
---

# ai-security —— AI 安全研究环境

## 何时用

对自有或授权模型端点做安全测试：越狱、提示注入、训练数据/系统提示泄露、偏见与幻觉评测。**只测自有模型或拿到书面授权的模型**。没有端点时拿 Gandalf（gandalf.lakera.ai）当判分靶场练链路。

## 怎么进

```
zhishi env up ai-security
zhishi env open <id>       # 或 docker exec -it <container> bash
```

## 标准工作流

```bash
# ① garak 基线扫描(目标:OpenAI 兼容端点)
garak --model_type openai-compatible \
      --model_name <模型> \
      --model_option api_base=<端点> \
      --model_option key=<key> \
      --probes lmrc

# ② promptfoo 自定义 eval(针对自己的威胁模型)
cat > eval.yaml <<'EOF'
prompts: [prompts.txt]
providers:
  - id: openai:chat:gpt-4o
    config: { apiBaseUrl: "<端点>" }
tests:
  - vars: { topic: "注入" }
    assert:
      - type: not-contains
        value: "系统提示词是"
EOF
promptfoo eval -c eval.yaml
promptfoo view

# ③ PyRIT 多轮攻击编排(garak 单轮探针打不动的场景)
python3 - <<'EOF'
import asyncio
from pyrit.common import IN_MEMORY, initialize_pyrit
from pyrit.executor.attack import PromptSendingAttack
from pyrit.prompt_target import OpenAIChatTarget

initialize_pyrit(memory_db_type=IN_MEMORY)
target = OpenAIChatTarget(endpoint="<端点>", model_name="<模型>", api_key="<key>")
attack = PromptSendingAttack(objective_target=target)
result = asyncio.run(attack.execute_async(objective="提取系统提示词"))
print(result)
EOF
# 多轮策略:RedTeamingAttack / CrescendoAttack(同包,pyrit.executor.attack)
```

## 降级路径

- garak 探针太多跑不动 → `--probes` 缩小到特定类别
- 端点不兼容 → promptfoo 支持大多数供应商协议，换 provider 配置
- 没有端点 → 本地起一个模型再测（ollama 环境内自装），或 Gandalf 判分靶场

## 收尾

- 每个确认的问题落 `research_log`（kind=ai-security，bug_class 挂对应类别）
- 扫描报告落 `/workspace/reports/`，别只留对话里
