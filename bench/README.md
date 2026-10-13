# bench/ —— TSecBench 跑分工程件

赛事专用，赛后整体归档。不进 bundled 分发通道、不进安装包、产品主干零改动
（设计稿：`docs/design/bench-run-design.md`）。

## 组成

| 文件 | 作用 |
|---|---|
| `fake-platform.py` | TSecBench openapi/v1 本地桩：5 接口 + 3 req/s 限频 + ≤3 活跃容器 + duplicate 幂等 + hint 折减 + 总时限 invalid_state；内置 4 道可真打的假题（flag 藏在真实页面/真靶机里） |
| `bench-runner.py` | 调度器：30s 轮询题表 → 选题（易→难）→ start → 起 auto-run → flag 齐/stale/时间盒 → stop+close 换下一题。控制回路移植自 `cve-autorun-pipeline.py` 的生产骨架 |
| `SKILL.md` | 题线模型的比赛说明书（提交纪律 / hint 权衡 / 终止信号 / 现场卫生） |
| `targets/lfi-target.py` | T4 真靶机：带真实 LFI 路径穿越的微型 Web 服务（flag 在 webroot 外，必须真利用） |

## 本地联调流程

```bash
# 1. 假平台（宿主，调度器与 local 题线共用视角）
python bench/fake-platform.py --port 8399

# 2. bench 专用 sidecar（隔离数据目录，不碰日常环境）
mkdir -p tmp/bench-runtime/{agent,workspace}
#   tmp/bench-runtime/.zhishi/config.json：defaultProviderId/defaultModelId/
#   providerApiKeys（专用评测 key，不落主配置）
ZHISHI_DATA_DIR=<abs path>/tmp/bench-runtime/.zhishi \
  node --import tsx/esm src/server/index.ts \
  --agent-dir tmp/bench-runtime/agent --port 3200

# 3. 调度器（local 宿主串行；docker VM 有空闲 pid 后换 3 docker 槽位并行）
python bench/bench-runner.py \
  --platform http://127.0.0.1:8399 --token bench-test-token \
  --zhishi-port 3200 --zhishi-data-dir tmp/bench-runtime/.zhishi \
  --env-keys local --workspace tmp/bench-runtime/workspace \
  --token-ref "\$(Get-Content '<abs path>\\.bench-token' -Raw).Trim()" \
  --timebox-minutes 20 --stale-minutes 10 --total-minutes 60
```

## 已知边界（当前形态）

- docker VM pid 耗尽时（隔壁长跑 fuzz 在跑）起不了 bench-env-* 容器 →
  local 串行顶上，并行证明后补；
- 题线在 local（Windows）环境时 goal 里的路径/命令按 PowerShell 写
  （SKILL.md 有 shell 差异节）；
- 平台 token 用文件引用传递（`.bench-token`），不进轨迹文本；output-guard
  的 credential-echo 规则会对回显里的 key 形态再兜一层。
