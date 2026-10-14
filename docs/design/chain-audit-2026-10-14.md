# ZhiShi 全项目关键链路审查

审查日期：2026-10-14。代码版本：工作树 package.json 为 1.9.8。

本轮只审查，不修改产品实现。共确认 11 个跨层缺陷，其中 10 个通过隔离调用验证，1 个依据完整读写路径静态确认。

“隔离验证”不等于桌面端端到端测试：调用了实际 handler、helper、运行时编排器，使用临时数据、假环境响应与假模型回合；没有启动真实研究命令，也没有调用真实模型。Rust 调度器和浏览器连接问题验证到接收端鉴权判定，未启动 Tauri 或操作浏览器。

## 1. [P1] 会话线隔离了，执行环境仍读取工作区全局选择

**触发条件：** 同一工作区存在两个用户的不同环境会话线；Bob 切换到环境 B，Alice 继续原来环境 A 的会话。后台战役也存在同类环境锚丢失。

**调用链：**

- [environment/select](file:///e:/code/u-disk/src/server/admin-api.ts#L4244-L4278) 的忙碌检查针对当前 actor，引擎切线也针对当前 actor，但 selection 写入 workspace 全局记录。
- [交互 turn](file:///e:/code/u-disk/src/server/loop/chat-engine.ts#L1152) 调用 `resolveSessionEnv(this.agentDir)`，没有使用该线已有的 `currentEnvKey`。
- [环境解析](file:///e:/code/u-disk/src/server/loop/chat-engine.ts#L362-L379) 只按工作区读取 selection，解析结果随后进入工具栈。
- [战役介入](file:///e:/code/u-disk/src/server/loop/chat-engine.ts#L2383-L2391) 只传 `loopSessionId`，没有传战役保存的 envId 对应环境锚；[invoke](file:///e:/code/u-disk/src/server/loop/chat-engine.ts#L1950-L1952) 再次回落到全局 selection。

**影响：** A 的研究历史可能驱动 B 的工具执行；采样环境与分诊环境可能不同。不是简单的 UI 标签错误。

**隔离验证：** Alice 上下文解析结果先为 A，Bob 修改同 workspace selection 后，Alice 再解析得到 B。未实际执行 SSH、Docker 或模型工具调用。

**修复方向：** 环境锚属于会话线或后台任务，执行期应从该 owner 解析；工作区当前选择仅用于选择/创建线，不能覆盖已绑定线的执行现场。

## 2. [P1] 旧会话接口遗漏私有线资源授权

**触发条件：** 启用团队鉴权，Alice 的线为私有；Bob 使用合法 token 访问 Alice 的 metadata sessionId。列表本身也没有按线归属过滤。

**调用链：**

- [路由分发](file:///e:/code/u-disk/src/server/index.ts#L1369-L1383) 直接进入 sessions handler；统一 auth gate 只检查路由角色。
- [详情读取](file:///e:/code/u-disk/src/server/routes/sessions.ts#L191-L203)、[删除](file:///e:/code/u-disk/src/server/routes/sessions.ts#L404-L416)、[修改](file:///e:/code/u-disk/src/server/routes/sessions.ts#L621) 未调用 `canReadLine` / `canWriteLine`。
- SessionStore 也不做 actor 授权。相比之下，新 loop transcript 接口以及 switch/fork 已有归属检查。

**影响：** 其他用户可查看私有会话元数据及旧格式保存的消息；operator 可修改标题、模型等字段，删除 metadata 与旧格式消息文件。这里的“删除”不包含主 `loop-sessions` 轨迹文件，不能理解成全部研究数据都被删除。

**隔离验证：** 临时创建 Alice 私有线及消息；Bob 的策略判定 `canReadLine=false`、`canWriteLine=false`，实际 handler 的 GET/PATCH/DELETE 均返回 200，消息被读出，标题被修改，metadata 被删除。

**修复方向：** 先由 metadata 解析 loopSessionId，再执行统一资源权限判断；列表过滤与详情、写入检查保持一致。`admin-archive` 的显式 sessionId 操作也应纳入同一授权检查面，避免逐入口遗漏。

## 3. [P1] 开启鉴权后 Rust 定时调度请求被 Sidecar 拒绝

**触发条件：** `auth.enabled=true`，由 Rust 定时任务系统发起普通任务或系统蒸馏任务。

**调用链：**

- task scheduler 调用 `execute_scheduled_task`。
- [Rust HTTP 请求](file:///e:/code/u-disk/src-tauri/src/sidecar.rs#L4664-L4681) 只有 `.post().json().send()`，未附带认证信息。
- `local_http::builder()` 只设置 `.no_proxy()`，不注入认证。
- [Sidecar 统一闸](file:///e:/code/u-disk/src/server/index.ts#L581-L595) 对 `/cron/execute-sync` 要求 operator，没有 localhost 自动豁免。

**影响：** 请求在进入 cron handler 前返回 401，普通任务与依赖该入口的认知/安全蒸馏任务无法执行。内部 session-state 轮询亦存在未携带认证的同类调用。

**隔离验证：** 使用启用鉴权的内存配置，对 Rust 发送的无 Authorization 请求形态调用真实 gate，得到 `{ok:false,status:401}`。未运行真实 Rust scheduler。

**修复方向：** 给内部调度调用明确、受控的认证身份，并补齐所有内部请求方；不能简单开放整个 localhost 或关闭路由鉴权。

## 4. [P2] 报告导出仍按旧会话映射键读取

**触发条件：** 研究事件和轨迹都存在，但 env-sessions 只有新三段式映射。

**调用链：**

- [映射写端](file:///e:/code/u-disk/src/server/loop/chat-engine.ts#L783-L799) 写 `workspace::actor/shared::env`，本机模式同样使用 `local` 归属段。
- [导出读端](file:///e:/code/u-disk/src/server/admin-api.ts#L3286-L3287) 调 `getEnvSessionLine` 时没有传 actor。
- [lookup](file:///e:/code/u-disk/src/server/environment/env-sessions.ts#L149-L164) 在 opts 缺席时只查旧两段式键。
- [exportReport](file:///e:/code/u-disk/src/server/report/export.ts#L120-L123) 因 transcript 不存在返回“没有可导出的研究记录”。

**影响：** 新会话无法导出；存在旧键时还可能读到旧线，而非当前研究线。

**隔离验证：** 同一张新键 map，不带 actor 返回 undefined，带 Alice 返回 `alice-line`。未执行真实报告写盘或审批交互。

**修复方向：** 导出与会话选择使用相同的 actor/线解析契约，并检查被导出线的读权限。

## 5. [P2] 战役的崩溃游标不推进，重复分诊同一批样本

**触发条件：** crashes 目录已有崩溃样本，分诊完成后样本数量不变。

**调用链：**

- [judgeNewCrashes](file:///e:/code/u-disk/src/server/loop/campaign.ts#L167-L169) 以 `crashCount - crashCursor` 判断新增量。
- [采样触发](file:///e:/code/u-disk/src/server/loop/campaign-runtime.ts#L273-L282) 进入 triaging。
- [介入结束](file:///e:/code/u-disk/src/server/loop/campaign-runtime.ts#L309-L322) 回到 running，却未推进 cursor。全生产代码中 cursor 只有初始化写入，没有后续更新。

**影响：** 相同样本不断触发模型分诊，重复消耗预算；新崩溃分支优先返回，还会挤占平台期判断。

**隔离验证：** 使用手动驱动的采样回调，连续提供两次相同 crashCount=2；实际发射两次分诊，cursor 仍为 0。没有等待真实定时器或调用模型。

**修复方向：** 定义“已消费样本”的提交时点，推进持久化游标，并覆盖分诊失败的重试语义。

## 6. [P2] 战役停止与在途介入完成发生非法状态转移

**触发条件：** 战役正在等待 `invokeRound`，此时用户停止战役，随后介入回合返回。

**调用链：**

- [stopCampaign](file:///e:/code/u-disk/src/server/loop/campaign-runtime.ts#L228-L234) 将 controller.record 改为 stopped 并移出 registry。
- 在途 [fireIntervention](file:///e:/code/u-disk/src/server/loop/campaign-runtime.ts#L312-L322) 恢复后无条件转回 running。
- 状态机拒绝 stopped → running；[timer 回调](file:///e:/code/u-disk/src/server/loop/campaign-runtime.ts#L207) 丢弃 tick Promise，没有捕获拒绝。

**影响：** 停止后的异步回调抛出未处理 rejection，生命周期没有正常闭合。是否导致整个 Sidecar 退出取决于进程级异常处理，本轮没有将其认定为必然进程崩溃。

**隔离验证：** 手动挂起 invoke，调用 stop，再释放 invoke；捕获一个 `非法状态转移 stopped → running` 的 `unhandledRejection`。

**修复方向：** 停止与异步完成共享同一生命周期契约；终态不可被迟到回调恢复，定时异步任务必须有明确的错误处理归属。

## 7. [P2] GUI 终端 WebSocket 未携带认证 token

**触发条件：** 启用鉴权，GUI 已配置有效 token，用户打开 attach 终端。

**调用链：**

- SSE/HTTP client 会附带 Bearer。
- [AttachView](file:///e:/code/u-disk/src/gui/src/components/AttachView.tsx#L104) 仅把 `client.base` 和 envKey 传给 `termUrl`。
- [termUrl](file:///e:/code/u-disk/src/gui/src/client/term-client.ts#L70-L73) 只拼 `?env=`，未携带 token。
- 浏览器 WebSocket 无法自定义 Authorization，而 [服务端 upgrade](file:///e:/code/u-disk/src/server/loop/term-pty.ts#L385-L396) 要求 Bearer 或 query token。

**影响：** 聊天可用但交互终端握手返回 401。

**隔离验证：** 使用实际 GUI URL helper 构造 URL，传入真实 upgrade 使用的 gate，返回 401。未做浏览器端握手测试。

**修复方向：** 由统一客户端认证能力构造 WS 连接参数；传 token 时同时避免日志和错误信息泄露凭据。

## 8. [P2] 内置 local 环境在终端解析阶段被判不存在

**触发条件：** 全新配置未物化 local 条目，环境列表可见“本机”，用户尝试 attach。

**调用链：**

- 环境列表使用 `listEnvironmentsWithBuiltin`，自动加入 local。
- [终端默认 resolver](file:///e:/code/u-disk/src/server/loop/term-pty.ts#L163-L165) 却使用只读配置原始条目的 `listEnvironments`。
- [attach](file:///e:/code/u-disk/src/server/loop/term-pty.ts#L205-L208) 找不到环境即返回，根本到不了已经支持 local 的 PTY spawn 分支。

**影响：** 开箱即见的本机环境无法打开交互终端；能力刷新等操作恰巧将 local 写入配置后，症状可能消失。

**隔离验证：** 临时配置不含 local；真实 TermSessionManager 输出“未找到环境 local”，注入的 PTY loader 未被调用。

**修复方向：** 运行时读侧统一使用包含内置环境的注册表；写回配置仍使用原始列表。

## 9. [P2] 请求上下文丢失 Actor.source，本机身份被重建为 token 身份

**触发条件：** 关闭 auth 后访问此前由其他 token 用户拥有的私有线。

**调用链：**

- gate 返回 `LOCAL_ACTOR`，其 source 为 local，权限矩阵允许本机访问。
- [HTTP 上下文](file:///e:/code/u-disk/src/server/index.ts#L599-L601) 只传播 name/role。
- [currentActor](file:///e:/code/u-disk/src/server/auth/actor.ts#L36-L45) 只要有 actorName 就强制重建 `source:'token'`。

**影响：** 关闭团队鉴权后，本机用户仍会被部分私有线写权限检查拒绝；本机请求还会意外触发“仅 token actor 登记 owner”的分支。

**隔离验证：** 按 index 的方式经过 ALS，source 从 local 变 token；对 Alice 私有线的 canWriteLine 从 true 变 false。

**修复方向：** 保留认证结果的完整身份语义，不能通过名字是否存在推断来源，也不应对名字 `local` 做特殊猜测。

## 10. [P2] 子代理注册了 recall，但委派默认白名单禁止调用它

**触发条件：** 通过正常 `delegate_task` 入口运行子代理，子代理需要取回被窗口置换的历史。

**调用链：**

- [引擎装配](file:///e:/code/u-disk/src/server/loop/chat-engine.ts#L1453-L1459) 未覆盖 childAllowedTools。
- [委派入口](file:///e:/code/u-disk/src/server/loop/subagent.ts#L224) 默认白名单仍为 `[env_exec]`，显式传给 spawnSubLoop。
- [子 loop](file:///e:/code/u-disk/src/server/loop/subagent.ts#L94-L100) 虽有 `[env_exec, recall]` 的新默认值及 recall 工具，但默认值被上游参数覆盖。
- boundary 据传入白名单拦截 recall。

**影响：** 指针卡提示模型可以 recall，真实工具调用却必然遭拒，历史取回契约断裂。

**隔离验证：** 调真实 delegate factory，用假 spawn 捕获下传参数，再交真实 boundary：`allowedTools=['env_exec']`，recall 返回 `block:true`。

**测试盲区：** 现有 subagent 单测甚至明确断言旧默认值只有 env_exec；仅让当前测试变绿不能保证产品契约正确。

**修复方向：** 工具注册与授权白名单必须同源；修复后还应单独验证长子回合执行中的原文是否已经持久化并可实际取回，不能只测“允许调用”。

## 11. [P2] 记忆蒸馏仍消费旧会话文件，新引擎轨迹没有进入证据窗

**触发条件：** 当前 pi 引擎创建的新会话仅有 loop-sessions 轨迹，没有 SDK 时代 sessions 消息副本。

**调用链：**

- [交互收尾](file:///e:/code/u-disk/src/server/loop/chat-engine.ts#L1774-L1779) 与 [headless 收尾](file:///e:/code/u-disk/src/server/loop/chat-engine.ts#L2091-L2096) 均通过 persistTrajectory 写 loop-sessions。
- [sessionExcerpt](file:///e:/code/u-disk/src/server/memory/distill-runner.ts#L257-L276) 仍直接读取 `sessions/<metadataId>.jsonl`。
- [recallContext](file:///e:/code/u-disk/src/server/memory/distill-runner.ts#L285-L318) 只扫描 `sessions/`，且只接受字符串 content 和旧时间字段格式。
- [settleRecalls](file:///e:/code/u-disk/src/server/memory/distill-runner.ts#L341-L345) 将该空上下文交给 judge；认知及研究蒸馏的会话摘录也沿用旧 reader。

**影响：** 研究事件仍可能进入蒸馏，因此不是“所有记忆功能都不工作”；但新会话正文缺席，效果结算缺少真实证据。仅改目录仍不够，还需处理 metadataId → loopSessionId、块状消息和时间格式。

**验证级别：** 静态闭合读写链确认；未执行真实蒸馏模型调用，也未推断 judge 必然给出何种错误 verdict。

**修复方向：** 让蒸馏消费统一 transcript 抽象，并按对应会话/研究事件选证据；旧格式作为兼容分支，而非唯一数据源。

## 验证与覆盖

已有测试结果：7 个测试文件、109 项通过。

- sessions：24
- auth actor：11
- auth gate：15
- env-sessions：11
- campaign：17
- term-pty：15
- subagent：16

隔离脚本完成 10 组验证：报告 lookup、cron gate、终端 gate、actor 传播、环境解析、私有会话读改删、local 终端 resolver、子代理 recall、重复分诊、停止竞态。数据目录在系统临时目录中创建，结束后清理；未接触真实配置或研究数据。

本轮追踪的关键面：CLI/GUI/HTTP/WS 入口、路由与资源权限、按 actor/线的引擎与环境绑定、Rust cron 到 Node invoke、战役状态机、子代理与上下文取回、会话持久化、报告导出、记忆蒸馏，以及情报更新的分页/水位/事务路径。文件传输与宿主 API 也做了入口和关键路径检查。

这不是“全仓每行均已验证”的保证。未做真实 Tauri、浏览器、模型、SSH、Docker、更新安装器及发布产物的端到端回归；没有发现确定缺陷的路径也不能因此判定为完全无缺陷。

未纳入已确认清单的疑点：引擎注册表在切入已有运行线时的覆盖、取消共享后的旧活跃指针与 SSE 订阅、战役预算耗尽后续命、显式模型参数的部分回退分支。它们仍需要独立复现，不能与上述 11 项混为一谈。

建议修复顺序：先处理执行现场绑定和私有资源授权，再补内部调用认证；随后修复报告/记忆/子代理的读写契约，最后收束战役与终端生命周期。每个修复先新增失败的回归用例，再调整实现，不通过放宽权限、吞异常或增加重试掩盖根因。
