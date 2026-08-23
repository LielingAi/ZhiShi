# 专家知识导入指南（expert import）

> 适用版本：ZhiShi ≥ 1.2.10。面向：想把整理好的专家知识（思路/技术/SOP）批量搬进知识库的研究员。

## 1. 定位：知识的三层分立

| 层 | 内容 | 谁说了算 |
|---|---|---|
| 情报原料库（intel） | CVE/漏洞情报等外部原料 | 自动聚合 |
| LLM 经验库（蒸馏弧） | 模型自己研究成败的沉淀 | 机器产出，人可判错降权 |
| **专家知识库（expert.db）** | **思路 / 技术知识 / SOP** | **人审定才进库** |

专家知识是最后一道门槛：当 LLM 不会、蒸馏弧和 skills 都解决不了时，这里是落脚点。所以它的入库纪律最严——每条都必须有审定人（reviewer）。

## 2. 命令速查

```bash
zhishi expert list                    # 全部条目
zhishi expert show <id>               # 单条详情
zhishi expert search <关键词>          # 全文检索（title/applicability/content/tags）
zhishi expert new <标题>              # 新建：打开编辑器写（frontmatter + 正文）
zhishi expert import <文件> [--reviewer <名>] [--json]   # 从 JSON/YAML 导入（本文重点）
zhishi expert edit <id>               # 修改（编辑器往返）
zhishi expert rm <id>                 # 删除
zhishi expert review                  # 审定 agent 起草的草稿
zhishi expert promote <事件id>        # 把研究经验晋升为专家知识
```

agent 侧联动：agent 在识别到知识缺口时用 `expert_search` 查库（决策级依据）；你说「存为专家知识」时它用 `expert_draft` 起草草稿，你 `expert review` 审定后才进库。

## 3. import 命令详解

```bash
zhishi expert import <文件.json|.yaml|.yml> [--reviewer <审定人>] [--json]
```

### 格式识别

- 扩展名优先：`.json` → JSON，`.yaml`/`.yml` → YAML；
- 无扩展名按内容嗅探（先试 JSON 再试 YAML）；
- 文件内容可以是**单个对象**（导入一条）或**对象数组**（批量导入）。

### 逐条校验、不阻塞

每条独立校验（规则见下节），失败的条目报「序号 + 标题 + 原因」然后继续下一条。退出码：全部失败 = 1；全部成功或部分成功 = 0（部分成功的失败明细在输出里逐条列出）。`--json` 输出结构化汇总（`ok` / `failed` 两个数组），供脚本判断。

### 两条强制规则

1. **provenance 一律按 `user` 入库**——文件里写 `builtin`/`promoted` 会被覆盖。内置知识只能随版本发布（bundled-expert），晋升只能走 `promote` 通道。
2. **reviewer 必填**——取值顺序：条目里的 `reviewer` 字段 → `--reviewer` 参数兜底 → 都没有则该条拒绝导入。权威性的来源必须是人，这条不设例外。

### 重复导入不去重

当前版本按次入库，**同一文件导入两次会产生两条条目**（导入通道暂无 content_hash 幂等去重——seed 管线有，import 没有）。重复了用 `expert rm` 清理。需要幂等去重的话提需求，后续版本加。

### 禁用条目

导入的条目一律是启用状态；想入库但暂不生效，导入后用 `zhishi expert edit <id>` 改。

## 4. 字段规范

| 字段 | 必填 | 约束 | 写法建议 |
|---|---|---|---|
| `title` | ✓ | 非空 | 一句话说清是什么知识，带场景（「堆喷前先确认分配器路径」优于「堆喷经验」） |
| `kind` | ✓ | `idea` / `technique` / `sop` | idea=思路判断，technique=具体技术，sop=步骤流程 |
| `domain` | ✓ | `binary` / `pentest` / `whitebox` / `ai-security` / `redteam` / `malware` / `intel` / `ctf` | 域是检索与反喂的分组键，选错域会被过滤掉 |
| `applicability` | ✓ | 非空 | 什么时候适用——越具体越好（环境/版本/前置条件） |
| `content` | ✓ | 非空 | 知识正文，多行用 YAML `|` 块标量 |
| `criteria` | ✓ | 非空 | 成立与失效的判定标准——这是「专家知识」和「随笔」的分界线 |
| `tags` | 可选 | 逗号分隔字符串 | 检索辅助 |
| `reviewer` | 见上 | 非空（或有 `--reviewer`） | 审定人 |

非法枚举值、缺必填字段都会逐条报出明确原因，不会静默入库。

## 5. 完整示例

仓库自带可直接导入的演示文件：[`docs/expert-import.demo.yaml`](./expert-import.demo.yaml)——三条条目覆盖三种 kind 和三个域。

```bash
# 导入演示文件
zhishi expert import docs/expert-import.demo.yaml
# 输出：
# ✓ #1 堆喷前先确认分配器路径（演示） → 入库 #6
# ✓ #2 内网横向的 SMB 签名前置探测（演示） → 入库 #7
# ✓ #3 白盒审计先画信任边界再追数据流（演示） → 入库 #8
# 导入完成：成功 3 条 / 失败 0 条

# 验证可检索
zhishi expert search 堆喷
# 清理演示条目
zhishi expert rm <id>
```

最小 JSON 单条示例：

```json
{
  "title": "栈溢出先定偏移再谈利用",
  "kind": "technique",
  "domain": "binary",
  "applicability": "任何栈溢出类题目的第一步",
  "content": "cyclic 生成模式串打崩，cyclic -l 从崩溃寄存器反查偏移；偏移不定下来，后面所有工作都是空中楼阁。",
  "criteria": "崩溃时控制寄存器（RIP/EIP）被模式串覆盖即成立。",
  "reviewer": "你的名字"
}
```

## 6. 常见问题

- **导入了但 agent 不用？** 专家知识是「兜底检索层」不是每轮注入——agent 在识别到知识缺口（反复失败/没把握/无先例）时才查。想让它常驻提示词的那部分写法请走 skills 或蒸馏。
- **YAML 里的多行正文**：用 `content: |` 块标量，缩进保持一致；别用 Tab 缩进（YAML 规范）。
- **导入失败提示缺 reviewer 但我写了**：检查 `reviewer` 字段拼写和值是否非空字符串。
- **想改已入库的条目**：`zhishi expert edit <id>` 走编辑器往返；删除用 `rm`。
