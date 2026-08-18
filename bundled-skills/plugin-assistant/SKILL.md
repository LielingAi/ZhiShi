---
name: plugin-assistant
description:
  ZhiShi 插件助手：编写、打包、加密、发布插件的全流程向导。当用户想"做一个插件"（把能力封装成
  含 skills/commands/agents/hooks/MCP 的插件包）、"把这个插件打包发给别人"、"加密插件/卖插件/
  做商业授权"、"给插件签名/发许可证"时加载。触发语："帮我写个插件"、"打包成插件"、"加密这个插件"、
  "怎么卖插件"、"发一个许可证"、"plugin pack/keygen"。反向边界：安装/管理已有插件走 zhishi-cli
  skill（plugin install/toggle）；沉淀单个工作流用 skill-creator / app-automation——只有要封装成
  可分发的插件包时才来这里。
---

# 插件助手（编写 → 打包 → 加密 → 发布）

ZhiShi 插件 = 一个目录，含 `.claude-plugin/plugin.json` + 组件（skills/commands/agents/hooks/MCP/…）。
加密插件（.zsp）= 该目录的加密签名包 + 一串 `ZSP1-…` 许可证。工具链全部在 `zhishi` CLI 本地
子命令里（无需 sidecar 运行，见 `specs/tech_docs/encrypted_plugins_t1.md`）。

## 一、编写插件

### 目录结构

```
my-plugin/
├── .claude-plugin/
│   └── plugin.json        # 唯一必需：清单
├── skills/<name>/SKILL.md # 技能（可选，可多个）
├── commands/<cmd>.md      # 斜杠命令（可选）
├── agents/<name>.md       # 子代理（可选）
├── hooks/hooks.json       # 事件钩子（可选）
├── .mcp.json              # MCP 服务器声明（可选）
└── bin/                   # 可执行工具（可选）
```

### plugin.json 最小清单

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "一句话说清这个插件干什么",
  "author": { "name": "your-name" }
}
```

`name` 规则：小写字母/数字/中横线/下划线（`^[a-z0-9][a-z0-9_-]*$`）——它是插件的永久 ID，
加密许可也绑它。version 用 semver，升级时递增。

### 本地明文迭代（先跑通再加密）

```bash
zhishi cc-plugin install file:///绝对路径/my-plugin   # 明文安装自测
# 开新会话验证 skills/commands 是否生效 → 改 → 重装
```

## 二、打包加密

```bash
# 一次性：创建 publisher 身份（密钥对存 ~/.zspack/<publisher>/，私钥不外发）
zhishi plugin init --publisher <你的名字或团队名>

# 在插件目录里打包（生成 dist/<name>-<version>.zsp）
cd my-plugin
zhishi plugin pack

# 自检（模拟买家：验签+解密是否通畅）
zhishi plugin keygen --plugin my-plugin -n 1      # 先给自己印一串
zhishi plugin verify dist/my-plugin-1.0.0.zsp --license ZSP1-…
```

然后在设置→插件里拖入 `.zsp`、粘贴许可串，确认激活安装全通。

## 三、发布与售卖

1. 把 `.zsp` 发给买家（网盘/微信/邮件随意——密文，不怕被扒）
2. 每卖一份：`zhishi plugin keygen --plugin my-plugin -n <份数>`，把许可串逐个发给买家
3. 买家：设置→插件→安装插件→选 .zsp→粘贴许可串→完成（永久激活，无网络、无到期）

**版本升级**：改 version 后重新 `plugin pack`（默认复用同一把 DEK，老买家的许可串
继续有效）；`--new-dek` 换新密钥则需要给买家重发许可串（可用于"大版本重新收费"）。

## 红线

- 私钥（~/.zspack/\<publisher\>/key.pem）**绝不进 git、绝不发给任何人**——它是签发权的全部
- 许可串按买家逐个签发并记录（哪串发给了谁），泄露可溯源、可停止签发新串
- .zsp 内是密文，但安装后买家机器上是明文——T1 防分发不防逆向，别在插件里放
  服务端密钥这类"泄露即致命"的东西（那种逻辑应该放远端服务，插件只当客户端）
