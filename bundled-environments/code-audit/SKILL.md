---
name: code-audit
description: 白盒审计研究环境——源码漏洞审计的环境。任务涉及源码级漏洞挖掘（审计开源项目、找注入/越权/逻辑漏洞、SCA 依赖审计）时使用。内置 semgrep（静态分析主力）+ pip-audit（依赖漏洞对照）+ ripgrep/universal-ctags（手工数据流追索）。CodeQL 不预装（下载大），需要时环境内自装。
base: docker
tools:
  - semgrep
  - osv-scanner
  - pip-audit
  - ripgrep
  - universal-ctags
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
semgrep scan --config auto .                 # ① 基线扫描(规则集 auto)
semgrep scan --config p/owasp-top-ten .      # ② 按场景换规则集
osv-scanner scan -r .                        # ③ SCA:多生态依赖漏洞对照
pip-audit -r requirements.txt                # ④ pip 生态补充
rg -n "exec\(|eval\(|SELECT" src/            # ⑤ 手工追索入口
```

## CodeQL（需要时自装,不预装）

```bash
# 下载 CLI + 建数据库 + 跑查询——见 bundled-skills/whitebox-audit 的降级路径
```

## 收尾

- 每个确认的漏洞落 `research_log`（kind=whitebox + bug_class + CWE 编号）
- 有 PoC/复现的写进工作区笔记,留痕轨迹
