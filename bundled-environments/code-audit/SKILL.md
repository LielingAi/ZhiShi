---
name: code-audit
description: 白盒审计研究环境——源码漏洞审计的环境。任务涉及源码级漏洞挖掘（审计开源项目、找注入/越权/逻辑漏洞、SCA 依赖审计）时使用。内置 OpenGrep（静态分析主力,Semgrep CE 的全兼容超集）+ Joern（污点传播,多语言 CPG,首跑自动安装,预置 joern-taint.sc 模板 CLI 化）+ ast-grep（即席 AST 搜索/重写）+ bandit（Python 专项）+ pip-audit/osv-scanner（SCA）+ ripgrep/universal-ctags（手工数据流追索）。CodeQL 不预装（下载大）,仅开源靶标条件启用,需要时环境内自装。
base: docker
tools:
  - opengrep
  - joern
  - joern-parse
  - sg
  - bandit
  - osv-scanner
  - pip-audit
  - rg
  - ctags
# 1.5.7 joern provision 化：移出镜像、容器首跑由 /opt/zhishi/first-run.sh
# 按需安装的工具——装完前能力探测显示「已登记待装」而非「无此能力」。
firstRunTools:
  - joern
  - joern-parse
---

# code-audit —— 白盒审计研究环境

## 何时用

源码级漏洞审计：审开源项目、找注入/越权/逻辑漏洞、SCA 依赖漏洞对照。
目标代码放工作区（`/workspace`）即可审计。

## 怎么进

```
zhishi env up code-audit
zhishi env open <id>       # 或 docker exec -it <container> bash
```

## 标准工作流

```bash
cd /workspace/<目标项目>
opengrep scan --config p/owasp-top-ten .       # ① 基线扫描(registry 规则运行时拉取,不随包分发)
opengrep scan --config <规则目录> .             # ② 本地/自定义规则集
bandit -r . -f txt                              # ③ Python 专项
osv-scanner scan -r .                           # ④ SCA:多生态依赖漏洞对照
pip-audit -r requirements.txt                   # ⑤ pip 生态补充
rg -n "exec\(|eval\(|SELECT" src/              # ⑥ 手工追索入口
```

## Joern 污点分析（1day/数据流主力）

1.5.7 起 joern 不随镜像预装（1.8GB 平台包）——容器首跑自动安装
（/opt/zhishi/first-run.sh，幂等）；装完前 `joern` 不可用属正常「待装」态。

```bash
joern-parse -o /workspace/out/target.cpg.bin .            # ① 建 CPG(多语言)
joern --script /opt/zhishi/joern-taint.sc \
      --params cpgFile=/workspace/out/target.cpg.bin      # ② 模板一把出 source→sink 流
```

`joern-taint.sc` 的 sources/sinks 名单按 bug_class 改；要交互深挖再进
`joern` REPL（`importCpg` 后 CPGQL 查询）。大项目给堆内存：`JAVA_OPTS=-Xmx8g joern ...`。

## ast-grep（即席 AST 搜索/重写）

```bash
sg run -p 'eval($CODE)' --lang python .        # 结构匹配,比 rg 少误报
sg run --rewrite '...' -p '...' . -i           # 交互式结构重写
```

## CodeQL（仅开源靶标条件启用,需要时自装）

```bash
# 下载 CLI + 建数据库 + 跑查询——见 bundled-skills/whitebox-audit 的降级路径
```

## 收尾

- 每个确认的漏洞落 `research_log`（kind=whitebox + bug_class + CWE 编号）
- 有 PoC/复现的写进工作区笔记,留痕轨迹
