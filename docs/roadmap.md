# Roadmap

> 版本任务池。1.0.0 = 安全研究员版定型；1.1.x = 能力补齐 + 引擎深化（已完成）；1.2.x = 研究交付 + 校准协作主线 + 做深不做广（已完成）；1.3.x = GUI 主线（会话/决策/历史 + 环境业务逻辑 + TUI 退役 + 质量审计，已完成，1.4.0 发版）；**当前线：1.4.x（GUI 正式版后——auto loop agent 已落地（1.4.1，设计 `docs/design/auto-loop-design.md`）；1.4.3 域模型归位已发版；1.4.4 研究档案已发版；1.4.5 质量审计已发版；1.4.6 Harness 复杂任务优化已发版；1.4.7 打磨收口已发版；1.4.8 研究档案本体迭代（反证结构 + 链式投影 + 假设第三终态 + confirmed 死状态修复）已发版；**1.4.9 环境元数据可信（MISS 显式化 + 绑定域认多配方 + 已有环境补齐链路）进行中**。记录在案：god file 拆分、引擎单例残余耦合（纯技术债，无 2.0 绑定——「引擎多实例」已随 2.0 范围砍单，2026-08-27 决策）。已砍：/bg 转后台（2026-08-26 决策——auto loop + env_bg 全覆盖其价值）、决策面板澄清提问（2026-08-27 决策——澄清是输入不是决策，普通对话打字即交互、auto loop 自主含义不允许向人要信息）、引擎多实例（2026-08-27 决策——与 TUI 多线同屏、跨机协同调度一起，2.0 范围砍单））**。
> 状态约定：`[ ]` 未开始 · `[~]` 进行中 · `[x]` 已完成。任务细节不写在这里——细节进对应设计文档。

---

## 1.4.9 —— 环境元数据可信：MISS 显式化 + 绑定域认多配方 + 已有环境补齐链路（进行中）

**缘起（2026-08-29 三连环实证，用户逐项对齐）**：①pwn-vm 研究会话中模型自查发现「能力清单声明 opengrep/joern 等可用，实际全缺」——能力重推只把命中工具归并成域，**MISS 清单不落盘**，「声明了但环境里没有」的标注数据源（toolCheck.missing）只覆盖 build 流程，adopt 环境永远没有缺失标注，模型把配方声明当在场证据。②实探发现 `boundDomainsForEntry` 候选只有 recipeId（单数）/id/vmName——**不认 1.3.8 的 recipeIds（多配方）**，辅配方绑定对能力集合零贡献（pwn-vm 的 whitebox 标签纯靠 ctags/rg/sg 探测命中撑着）。③「重推该不该装工具」讨论定稿：**探测只读不装**（触发点全是顺手场景，带副作用违反最小惊讶；工具版本是研究员的显式决策），但「发现缺失之后没有下文」是断链——已有环境没有装工具的产品入口（environment/install 是装宿主引擎不是装工具、build 只服务从零新建、GUI 对两端点零调用）。**实探数据（2026-08-29，67 工具面全量探测 pwn-vm）：binary 20/30 名实相符；pentest 4/21、whitebox 3/9、ai-security 1/4 由个别工具撑标签。**

- [x] **MISS 落盘 + 在场显式化**：`probeEnvironmentCapabilities` 把探测面 MISS 清单（surface − present）落盘 `EnvironmentEntry.capabilityMissing`（全集落盘，展示侧过滤）；能力清单段「声明了但环境里没有」标注数据源换 `capabilityMissing ∪ toolCheck.missing`（adopt 环境也可见）；GUI 环境卡片显示「在场 M/N」+ 缺失清单（悬停/展开）。
- [x] **绑定域认 recipeIds**：`boundDomainsForEntry` 候选展开 recipeIds（主配方恒在前）；回归——绑 code-audit 后 whitebox 恒在集合（不再靠探测命中撑着）；与①互补：标签声明变宽的同时缺失显式化，名实分离但都可查。
- [x] **已有环境补齐链路**：新端点 `environment/setup`——对已有环境重放配方的安装脚本：VM 配方直接重放 setup.sh（自带 sudo 安装段；`sudo -n` 检测，不免密 → 明确报错「需要免密 sudo」）；docker 配方绑 VM 属跨基底——**配方格式加可选 `provision.sh`**（裸机/VM 通用安装脚本，与 Dockerfile 安装段同源），code-audit 首个落地（opengrep/joern/ast-grep/bandit/pip-audit/osv-scanner，对应 1.2.5 选型清单）；长任务有界超时 + 日志尾部返回；成功后自动重推能力（闭环）。GUI 环境卡片「补齐环境」入口（有缺失时显示，确认后执行，结果 toast + 列表自动刷新）。**前置：VM setup.sh 幂等化改造**——pentest-vm 的 ZAP 段非幂等（已有 /opt/zaproxy 时重放会把新目录 mv 进旧目录、zap.sh 软链打断）必须修；nuclei/katana/ZAP 走最新 release（重放 = 升级非复原，各段加 `command -v` 已装跳过守卫）。
- [x] **回归 + 验证**：capability-derive 单测（MISS 落盘/recipeIds 绑定/合并顺序）；provision 通道单测（exec 注入假通道：成功/失败/sudo 不免密/超时）；全量测试 + typecheck + eslint + 构建；实机（pwn-vm：重推 → 缺失可见 → 补齐 code-audit → opengrep 在场 → 标签闭环）。

> 实际落地（2026-08-29）：①MISS 落盘——`probeEnvironmentCapabilities`/`runEnvProbeWithCapabilities` 双路产出 capabilityMissing（surface−present）；refreshEntryCapabilities/domain-check/env-up 三处回写全部带上（**自查抓出 domain/check 显式挑字段丢 capabilityMissing 的断链**）；能力清单段缺失标注源扩为 toolCheck ∪ capabilityMissing + 引导文案。②绑定域认 recipeIds——candidates 加 recipeIds（在前，主配方恒在 recipeIds[0]，基线语义不变）。③补齐链路——新模块 `environment/provision.ts`（纯函数：脚本解析 VM→setup.sh/docker→provision.sh、sudo 判定、base64 包装、日志尾部；唯一 IO provisionEnvironment：sudo -n 预检不免密不进场 → base64 传输执行 20min 有界 → 失败带 logTail）；`environment/setup` 端点（payload.recipe 缺省跑全部绑定配方、失败即停、成功自动 refreshEntryCapabilities 闭环）；GUI 徽章「缺 N」+ tooltip「在场 M/N + 缺失清单」+ 「⋯→补齐环境」菜单 + 确认模态（m-info 不存在样式的自查修复→m-note）。**幂等化前置**：pentest-vm setup.sh 三修（ZAP 段已装跳过——重放打断软链的实机坑修复、install_go_bin/SecLists/playwright 加守卫）。**源码自查另修**：CapabilityExecFn 类型拓宽（补 exitCode/stderr——provision 判败依赖，原类型是谎言）、exitCode 缺省不误判、provisionScriptCandidates 单元素数组简化。**实机两轮（pwn-vm 真补齐 code-audit）**：第一轮 pypi 系全成（清华镜像回落）、GitHub 系全挂（joern 300s 下 5.7/46MB、osv-scanner install.sh 404）→ provision.sh 加 gh_dl 镜像回落（gh-proxy.com）+ osv-scanner 改直接 release 二进制；第二轮 opengrep/osv-scanner 装上（在场 29→34），**joern 仍缺——gh-proxy 对 >40MB 文件 404、直连 60s 仅 9 字节，记录为环境网络限制**（WARN 不阻塞 + 缺失持续可见 + 幂等可重试，网络恢复后点「补齐环境」即可）。回归：新增 19 单测（capability-derive 6 + provision 8 + prompt 1 + GUI 2 + 既有断言按新契约更新 2）；全量 182 文件 2408 测试绿 + typecheck + eslint + 三构建绿。
> 取舍记录在案：①重推保持只读不装工具（用户拍板定稿）。②补齐粒度 = 整配方安装脚本重放，**不做按工具补齐**（配方无 per-tool 安装命令表，粒度 invented 出来的是空中楼阁）。③docker 配方的 Dockerfile RUN 段不做「提取翻译到裸机」的脆弱转换——走显式 provision.sh（同源手写，code-audit 试点，其他 docker 配方验证可行后补）。④setup 重放的 sudo 只认免密（`sudo -n`）——密码通道不做（凭据不进新链路）。
> 不做（本版）：按工具补齐、Dockerfile RUN 提取转换、GUI 环境构建（build）入口、引擎安装（environment/install）GUI 化、**Windows 目标机**（整个环境体系是 POSIX 假设——探测协议 `command -v`、setup.sh/provision.sh 全 bash、env-exec 走 ssh+sh；Windows 支持是探测/exec/配方全链的独立主题，不是本版一块）。
> 验收：全量测试 + 实机闭环（pwn-vm 补齐 code-audit 全链）。

---

## 1.4.8 —— 研究档案本体迭代：反证结构 + 链式投影 + 假设第三终态（已完成）

**缘起（2026-08-28 用户全程对齐，三层缺口讨论定稿）**：①**confirmed 死状态**（前置已修，master 直推 5c0645f）——HypothesisStatus 声明 confirmed 但无路径可达，假设永远卡「待验证」；resolve op 按实体类型路由（H#→confirmed / Q#→resolved）+ GUI 行内「✓ 证实」+ 教学双终态口径。②**结论无反证结构**——links 无极性，结论只能挂支持性证据，反对它的实验结果没有结构化的家（只能事后 correct 推翻）→ 确认偏误（看板永远「+N」）+ 丢失「带保留成立」中间态。③**N 假设/N 证据/N 结论平铺对不上号**——对应关系在 links 里（V→H 驱动、C→V 支撑），但看板按类型分摞，人脑做反向索引，N 大即崩。④**假设缺第三终态**——「我不追了」（方向变/不再相关）≠「我错了」（falsified），目前人停掉假设只能走纠正强制 falsified，语义过重。**用户拍板：链式投影替换类型分区（不做双视图——两套投影就是两套真相）；反证共存不自动推翻结论。**

- [x] **反证结构（against）**：finding 增加可选 `against` 引用（V# 反证，与 refs 支持并列）；research_archive 工具 finding op 加 against 参数（校验挂已存在 V#，同 refs 口径）；注入投影/报告投影/GUI 结论行显示「+N 支持 / −M 反证」；纪律（教学层）：反证共存不自动推翻——累积到动摇结论仍走 correct 翻转，「−M」是公开压力信号；旧档案无 against 读侧容错，不做存量迁移。
- [x] **链式投影（替换类型分区）**：纯函数反向索引派生研究线——H# → 其证据（V 的 refs 挂 H#）→ 其结论（C 的 refs 经 V 反推 + C 直挂 H#）→ 反证挂边；**孤儿区显式化**（未挂假设的证据、断链的结论——看得见的断链，装不了不知道）；GUI ResearchPanel 替换为链式分组（保留行内纠正/✓ 证实/跳流/引用高亮交互；类型分区选择器删除）；档案文件结构不动（链是派生不是存储）。
- [x] **挂链纪律（提醒级，同 1.4.7 弱约束路线）**：op=evidence 未挂 H# → 返回文本提醒「未挂驱动假设，将进孤儿区」（不拒绝——「顺手观察」是合法语义）；op=finding refs 无 H# → 提醒挂回结晶来源；kernel 档案段/auto-run brief/declare-completion 提醒同步「挂链 + 反证 + 三终态」口径。
- [x] **假设第三终态 abandoned**：research_archive 新 op `abandon`（id=H#/Q#，reason 必填，留痕）；人侧 GUI 行内「搁置」入口（与「纠正=标错」「✓ 证实」三键分立）；人纠正假设仍 → falsified（断言错了）不动。
- [x] **回归 + 验证**：链派生纯函数单测（链组装/孤儿归集/反证计数/断链容错/纠正后链重排）、against 校验、abandon 通道（含已证实不可放弃、人侧入口）、GUI 链式模型层；全量测试 + typecheck + eslint + 三构建；实机走查（真实会话档案链式渲染 + 反证显示 + 孤儿区可见）。

> 实际落地（2026-08-28）：①反证结构——ArchiveEntity 加可选 `against: string[]`（仅 finding，buildEntity 只收 V# 形态）；工具层 against 校验与 refs 同口径（必须挂已存在证据实体，错误文本引导先 op=evidence）；注入投影结论行追加「（反证 V#N）」、报告投影「—— 反证：V#N」、GUI 结论行「+N/−M」计数徽章 + 反证引用 chip（红色 −V#N 可点高亮）。②链式投影——GUI model 层 `archiveThreads`/`archiveOrphans` 纯函数（反向索引派生：证据 links 挂 H# 归线；结论直挂 H# 优先、经链上 V# 反推次之，跨线结论被先扫到的线认领；孤儿 = 未挂假设的证据 + 不挂线的结论）；ResearchPanel 重写为三区（待答问题 / 研究线（终态线默认折叠，空线显示「还没有证据——假设待实验驱动」）/ 孤儿区（断链提示文案））；行内交互保留（纠正/✓ 证实/跳流/引用高亮）+ 纠正理由内联展示（correctionByTarget 映射）；类型分区选择器保留给 HistoryPanel 历史回看（只读分组，不删）。③挂链纪律——op=evidence 无 H# → 返回文本提醒「会进孤儿区」；op=finding refs 无 H# → 提醒「会断链」；均不拒绝。④第三终态——`abandonEntity`（H#/Q# pending/open → abandoned，理由进 note: 链接，**不进纠正台账**——不追了≠错了；已有终态拒绝）；工具新 op `abandon`（reason 必填）；admin `archive/abandon` 端点 + GUI 编辑区「搁置」按钮（与纠正同输入框，按钮分立）；报告投影「证伪与纠正」节并入「已搁置：理由」行。⑤教学三处同步（kernel 档案段/auto-run brief 第 5 条/declare-completion 提醒）——SECURITY_KERNEL_MAX_CHARS 2500→2700（档案教学段增至 2.5K+，防静默截尾重演，注释记账）。回归测试：server 6 新增（against 持久化读回/abandon×2/注入与报告投影反证与搁置/工具 against 校验/挂链提醒/abandon op）+ GUI 4 新增（链组装/孤儿归集/against 归一化与计数/空态）；全量 152 文件 2186 测试绿 + typecheck + eslint + 三构建绿。**实机走查（2026-08-28 自查通过）**：新 bundle 独立 sidecar（bundled node，:31499）+ 10 实体全形态种子档案（完整链+反证/证伪线/搁置线/孤儿证据/断链结论）——HTTP 链路：archive/list（against 字段完整返回）、archive/resolve（H#1 pending→confirmed、note 挂链）、archive/abandon（Q#1→abandoned、不进纠正台账）、archive/correct（C#2→corrected、humanCorrected、R# 递增）全通；GUI 链式看板（headless Edge + CDP 驱动 broadcast 填充）：DOM 断言——研究线 3 / 孤儿区（断链）2 / +1 徽章 ×2 / −1 反证徽章 / 状态 chip 全形态（已证实/已证伪/放弃/被纠正/人纠正/有效/成立）/ 空态不误出，截图复核——H#1 线展开（V#1/V#2 挂线、C#1「成立 +1 −1」反证 chip −V#2 红色可点）、H#2 证伪线默认折叠带纠正留痕、H#3 放弃线折叠、孤儿区提示文案可见。（走查插曲：Git Bash curl -d 中文按 GBK 发码导致 note 乱码——走查工件问题非代码 bug，改 --data-binary @file 后正常。）

> 取舍记录在案：挂链纪律走提醒级而非工具层硬闸（对比 1.4.6 finding 举证强度硬闸——evidence 的「顺手观察」语义合法，硬闸会误伤；结构压力靠孤儿区显式化）。历史会话档案链式渲染时孤儿区偏大是预期（纪律收紧前的存量数据），不做迁移。
> 不做（本版）：双视图并存（已拍板替换）、反证自动推翻结论、finding 状态机加「存疑」档（让反证数本身说话）、档案图化、跨会话档案（蒸馏弧职责）。
> 验收：全量测试 + 实机走查。

---

## 1.4.7 —— 打磨收口（已完成）

**缘起（2026-08-28 用户逐项拍板，1.4.6 dogfood 遗留）**：1.4.6 收掉 1.x 头号正题后，剩余小尾巴逐项定夺：①观察卡轮内进度——长轮中预算不动，加「第 N 轮进行中」指示（可以，做）；②历史 ⚡ run 行的「载回续跑」按钮——run 无会话元绑定，点了报错，**藏起来**；③1.4.5 挂账裁决——研究档案问题（Q#）纠正语义：**算放弃**（当前实现 a：纠正问题 → abandoned，定为定稿，挂账结案）；④证伪结案提醒——declare_completion 时若档案有待验证假设，返回里带一句提醒（不阻塞，模型用不用随它——用户原话「可以，但是他可能也不会用」）；⑤工程卫生做掉：god file 绞杀续拆、原子写 helper 迁移、zhishi.ts 主体单测、SSE 对账漏面（G-13/G-14/G-21）。

- [x] **观察卡轮内进度**：运行中长轮显示「第 N 轮进行中」（N = turns+1）+ 轮内耗时（turn 开始到现在的秒数，观察卡每秒自增）。
- [x] **历史 ⚡ run 行藏「载回续跑」**：合成行（id 前缀 `auto-run:`）不渲染续跑按钮。
- [x] **①裁决定稿**：纠正未决问题 → abandoned（当前实现）定为定稿；1.4.5 挂账条目移除。
- [x] **证伪结案提醒**：declare_completion 执行时，档案有待验证假设（pending）→ 返回文本追加提醒「档案里还有待验证假设（H#…），确认前要证伪/解决掉」；不强约束。
- [x] **工程卫生**：god file 绞杀续拆（admin-api.ts 或 index.ts 再抽一块）+ 原子写 helper 迁移（session.ts/archive.ts/auto-run.ts 的 tmp+rename 段收编）+ zhishi.ts 主体单测起步 + SSE 对账漏面（G-13/G-14/G-21）。

> 实际落地（2026-08-28）：①`turnProgressOf` 纯函数（running 态 → 当前轮号=turnCount+1、耗时=now−updatedAt）+ AutoRunCard 每秒自增显示「第 N 轮进行中 · Ns」（非 running 不显示）——1.4.6 走查的 0/40 观感残留收口。②HistoryPanel 的 ⚡ 合成行（id 前缀 `auto-run:`）不渲染「载回续跑」按钮。③1.4.5 挂账结案：纠正未决问题 → abandoned 定为定稿（1.4.5 已有实现 + 回归测试，本版无代码改动）。④declare-completion 执行时档案有待验证假设 → 返回文本追加提醒（H# 列表 + falsify 指引，不阻塞声明登记；读侧容错零提醒不炸）。⑤工程卫生四项：a) 原子写——`writeFileAtomic` 进 file-lock.ts（tmp+rename 收编），session/archive/auto-run 三处内联实现迁移（回归测试：落盘/覆盖/中文长内容）；b) zhishi.ts 主体单测起步——parseArgs + camelCase 抽离为 `src/cli/cli-args.ts`（无 IO 无 process.exit 的纯边界层），9 个解析单测；c) god file 续拆——admin-api.ts 的 archive/list + archive/correct 抽到 `src/server/admin-archive.ts`（re-export 保持调用点不动，AdminResponse 索引签名对齐），4400→4362 行；d) SSE 漏面对账——注册表 40 事件 × GUI 消费面：3 个有意不消费（reducer 注释已写明 chat:logs/subagent-tool-result-complete/chat:log）、config:changed 记录在案（设置页开即重拉）、**chat:session-title-changed 真缺口**（auto-titler 改标题后 GUI 不刷新）→ `applySessionTitleChange` 纯函数 + store 消费（已加载历史行就地换标题，回归测试钉死）。新增 13 单测；全量 181 文件 2376 测试绿 + typecheck + eslint + 三构建绿。
>
> 不做（本版）：档案图化、跨会话档案（蒸馏弧职责）、历史 run 真续跑（藏按钮即可）、新功能。
> 验收：全量测试 + 实机走查。

---

## 1.4.6 —— Harness 复杂任务优化（已完成）

**缘起（2026-08-27 实证立项，证据两份全链路）**：①golang 轨迹取证（mta7eilu，508 消息真实复杂任务）——三环台账：相位体系失真（recon 全程 0 段、「验证」泛词顶成 evaluation ×4、construction 0 段，根因 = 相位信号是渗透口味关键词表）；思路供给有但全靠流内临时组织（编号混淆 msg 354 实证：research_log #2 被 #6 推翻但推翻关系无机械链接）。②cJSON 三轮 dogfood（auto loop + deepseek）——档案实证：第 1 轮完整链（Q#1→H#1→V#→C#），第 3 轮退化为**只写 3 条结论、零证据实体零引用**（轨迹实证：3 次 research_archive 全 op=finding、refs 全空）；证伪两轮一致记成 finding 文本（falsify/correct 零调用）；预算计数 off-by-one（声明轮不计 spent，显示 0/40）；声明被预检拒后 verdictPackage 残留出幽灵终审弹窗。另当场修复 6 项已发功能 UX bug（已提交 44ce8a0：终审恢复链路/records 键/档案接线/服务端归一化/历史档案查看/auto-run 合成行）。

- [x] **相位体系修复**（golang 取证 P0）：相位信号词表缺白盒/二进制/AI 安全侦察信号 + 「验证」泛词污染 evaluation。修法评审三选一：换/扩词表（各域信号并入 domain.json？）/ 档案实体流推相位（实体类型 → 相位）/ 相位整体降级为展示用途（不进 stall 判定与压缩权重）。
- [x] **档案举证强度**（cJSON 实证 P0）：「结论必须有证据支撑（挂 V# 引用）」从教学变成约束——修法评审：工具层校验（op=finding 强制 refs 挂已存在 V#，无证据实体先写 evidence）/ declare_completion 时 harness 预检查档案完整性（结论无证据引用 → 打回补充，与验收包预检同族）/ 教学强化（证伪必须走 falsify/correct 的明确纪律）。
- [x] **预算计数 off-by-one 修复**（实证）：达成声明的那一轮计入 spent（turns=1 显示 0/40 的错示）。
- [x] **幽灵 verdictPackage 修复**（实证）：声明被预检拒掉时清 verdictPackage（或恢复时按 status 校验——非 awaiting-verdict 不出弹窗）。
- [x] **research_log ↔ 档案双通道关系**（golang msg 354 实证：#2 撞车 + 推翻关系无机械链接）：评审——档案编号（C#/V#）与 research_log 编号（#N）的统一/分工口径。
- [x] **环境坑防护**：standalone 起 sidecar 必须用 bundled node（sqlite ABI 137/127 实证）——启动脚本/文档写明 + 探测告警（better-sqlite3 加载失败时启动日志显式报错）。
- [x] **auto-run 左屏过程**（评审项）：「左过程右成果」分屏语义在 auto-run 下左屏空——run 活跃时左屏渲染 run 的线（只读观察模式）是否做、怎么做。

> 实际落地（2026-08-28）：①相位体系——`PHASE_SIGNALS` 扩域（recon +攻击面/侦察/梳理/盘点/情报/CVE-\d+/toolchain/工具链/下载/安装；analysis +源码/静态分析/codegen/lowering/ssa/类型检查/汇编；construction +harness/seed/构造/驱动；execution +复现/崩溃/crash/asan；evaluation 去裸「验证」留复测/回归/验收/评估/结论）——**评审选项取「换/扩词表」**：档案实体流推相位被否（档案纪律自身尚不稳定，项②证据）、相位降级被否（stall 相位信号是双信号之一）。golang 重放验证：recon 正确出现（原 evaluation×4 全纠），相位流 recon→analysis→construction→execution 合理。②档案举证强度——**工具层硬约束**：op=finding 强制 refs 挂至少一个已存在 V# 证据实体（无 refs/挂不存在 V#/挂 H# 均拒绝，错误文本引导先 op=evidence 再下结论；约束在工具层，addFinding 模块层保持宽松——admin/迁移合法写入不受影响）+ 证伪教学强化（工具描述与 kernel 纪律 ③ 改「证伪/纠错必须走 falsify/correct，不要把证伪写进 finding 文本冒充成立」）。评审选项取「工具层校验」。③预算 off-by-one——预算消耗改在声明分支前更新（步骤 6 重算幂等不受影响；回归测试：声明轮 spent=1）。④幽灵 verdictPackage——终审作答即清 verdictPackage（declaration 陈述保留作历史；回归测试：pass 后记录与落盘均无 package）。⑤E#N 口径——research_log 返回文本改 E#N（promote 命令仍数字 #）、declare-completion/auto-run 描述、kernel 研究记录教学段统一 E#N（与档案实体 H#/V#/C#/Q# 区分）。⑥环境坑——`probeSqliteAvailable()` 启动探测（deferred init 首个 phase 前），better-sqlite3 ABI 不匹配时启动日志显式报错并指明用内置 Node；CLAUDE.md 开发命令补「编译产物直跑必须用内置 node」。⑦左屏观察——`AutoRunStream` 组件：auto loop 活跃时左屏渲染 run 的 wire transcript（5s 轮询只读回放，轨迹按轮次落盘，观察粒度=已完成轮次），顶置「观察模式」横幅，底部吸附；run 结束回落交互 Stream。新增 6 回归单测（预算/幽灵包/举证强度×3/合成行已计）+ 既有测试按新契约更新（finding 先挂证据）；全量 179 文件 2357 测试绿 + typecheck + eslint + 双构建绿。
>
> **走查增量修复（实机走查抓出，2026-08-28 实机四轮验证）**：⑧档案纪律对 auto-run 不可见（security kernel 不注入 auto-run 场景——第 4 轮模型 0 次调用 research_archive，纪律采用率随采样漂移）→ 档案纪律补进 auto-run 驱动文本（首轮纪律第 5 条 + 后续轮提醒；第 5 轮实证档案出完整链 Q#1→H#1→V#1-4→C#1-3 全带引用）。⑨观察卡字段错位（server 发 `turn`/`budget.spent`，GUI 读 `turnCount`/`used`——轮次与预算从来就没对过，live SSE 与 list 恢复同错）→ reducer 两处 + autoRunEntryOf 三处兼容映射（回归测试钉死；走查实机显示 1/40 ✓）。⑩锚点语义撞车（模型把工作步骤编号当「轮」，与 auto loop 轮次不一致）→ anchor 规范统一为「env_exec #N / 命令名 / 文件:行号」（工具参数/kernel/驱动文本三处教学，禁用「轮」）。⑪孤儿 awaiting-verdict 记录（sidecar 重启后内存 runner 消亡，盘上记录弹得出但永远答不了——用户实机被卡死）→ GUI 弹窗只在 awaiting-verdict 态出 + `resolveAutoRunVerdict` 盘上兜底结算（pass→completed / fail→stopped 清 package；continue 明确报错不可续跑；4 回归测试）。走查实证：预算 1/40 ✓、档案完整链 ✓、终审弹窗正常 ✓。全量 179 文件 2362 测试绿。
>
> 不做（本版）：引擎多实例（已砍）、澄清提问（已砍）、档案图化（后续候选）、跨会话档案（蒸馏弧职责）、历史 run 续跑（载回按钮路径，后置）。
> 挂账沿用：研究档案问题（Q#）纠正语义裁决（1.4.5 挂账）。
> 验收：全量测试 + dogfood 复测（cJSON 同任务重跑——档案应出完整链（假设/证据/结论带 V# 引用）、证伪走 falsify/correct、相位 recon 出现且不误判、预算计数正确、无幽灵弹窗）。

---

## 1.4.3 —— 域模型归位：环境/配方/域三层解耦（已完成）

**缘起（dogfood 根因，2026-08-27 用户全程对齐）**：golang 编译器白盒审计会话中，域判定全程锁死 binary（SIGSEGV 信号 437 vs whitebox 0），whitebox-audit 方法论从未注入。根因链：①signals 本是 TUI 折叠卡摘要的**产物指纹**，1.2.7 借作「内容信号」判域（错位一）；②1.3.7 把域过滤从「预算优化」升级成「正确性闸门」（集合外不切），违背 1.2.7 红线 #5「域过滤是预算优化，不是正确性闸门」（错位二）；③`capabilityDomains` 命名把「工具探测面」冒充成「域」（错位三）；④domain.json `recipes[]` 从属语义让配方与域成了层级而非平级（错位四）。**用户拍板定稿：环境=主体（绑 N 配方）；配方=环境构建维度（类型+工具+打法）；域=研究知识维度（skills/子代理/研究记忆注入），只由任务内容判定；配方与域平级弱关联（常见搭配）。**

- [x] **概念归位（数据/命名）**：`capabilityDomains` 语义重定位为「工具面标签」（仅能力清单展示用，不参与研究域裁决；字段名保留免迁移——用户拍板）；domain.json `recipes[]` 语义降级为「常见搭配提示」（弱先验，不再是归属/裁决依据）；相关注释/文档同步。
- [x] **域判定改造**：域 = 研究类型，只由任务内容判定。基线 = 配方→域弱先验（候选）；**移除 1.3.7「集合外不切」硬闸**；无配方环境（手动接入）无弱先验时，工具面推导仅作保守候选（1.3.7 语义降级保留为「无信号时的兜底」）；「无域信号降级全量注入（宁多勿缺）」安全阀恢复（1.2.7 红线 #5）。
- [x] **任务内容信号源（实验先行）**：拿 golang 会话（mta7eilu）当样本——设计**内容特征**（研究内容/任务性质/方法特征，非产物指纹），产物指纹降级为辅助证据；产出新 signals 定义与判定阈值（考虑轻量内容分类器，用户 1.2.7 提过词性模型方向）；六场景回归重跑。
- [x] **注入面归位**：skills/子代理/研究记忆按研究域（任务内容）注入；能力清单按环境配方并集 + 工具探测展示（工具面，1.3.7 语义保留）。
- [x] **验证**：golang 会话重跑 → 域应判 whitebox、whitebox-audit 注入；1.2.7 六场景回归；域切换场景单测。

> 实际落地（2026-08-27）：①概念归位——`capabilityDomains` 字段名保留、语义改为「工具面标签」（config-types.ts 注释重写；消费面收敛为能力清单段 filterKinds + resolveSessionResearchDomain 弱先验 + GUI 能力徽章，「裁决空间收窄（集合外不切）」删除）；domain.json `recipes[]` 降级为弱先验（常见搭配提示）。②域判定改造——`resolveSessionDomain` 重写：基线=配方→域弱先验（候选非裁决空间），裁决只看内容信号（某域命中 ≥2 且严格最多；跨基线改判需 ≥3 且 ≥2×基线域命中）；1.3.7 硬闸删除；`buildSecurityCapabilitiesSection` 不再按研究域收窄（filterKinds 只取选中环境 capabilityDomains，无能力字段全量）；无信号/打平→维持基线，无基线→全量注入（红线 #5 恢复）。③信号源重定义——4 份 domain.json：signals=内容特征（binary：ROP|栈溢出|gdb|0day 等；pentest：nmap|sqlmap|getshell|侦察 等；whitebox：审计|数据流|opengrep|CWE-\d+|编译器 等；ai-security：提示注入|garak|probe 等），auxSignals=产物指纹（SIGSEGV|session opened|garak 输出形态，不参与裁决）；binary「exp」加词边界（`exploit|exp(?![a-z])`，堵 expect/export 误命中）；`validateDomainManifest` 顺带校验 auxSignals 正则；loader 读入 auxSignals。④注入面归位——skills/子代理/研究记忆仍按研究域注入；能力清单按环境配方并集+工具探测展示。⑤验证——golang 会话（mta7eilu）重跑 recent=20/10/5 全判 **whitebox** ✓（根因场景纠正）；1.2.7 六场景+极端场景回归绿（S1 切换轨迹 / S2 binary↔whitebox 切换 / S6 误判代价量化）；system-prompt-security 新增 1.4.3 归位用例（纯 SIGSEGV 不拉向 binary、集合外内容照常改判、纯内容信号改判）；两个旧信号夹具更新（chat-engine 内容信号改判、scenarios binaryCrashTurn 加「栈溢出」内容特征）；全量 177 文件 2308 测试绿（1719 过 7 跳过）+ typecheck + eslint + build:server 绿；新 bundle 独立端口起服冒烟（/health ok、/health/ready|functional ready）。实机走查待用户验收（发版后安装包实测：白盒类对话域判 whitebox）。

> 不做（本版）：决策面板 harness 拦截澄清提问（2026-08-27 已砍，理由见 1.4.4）、研究结构显性化（研究看板 → 1.4.4 立项）。
> 验收：全量测试 + 根因场景复测（golang 会话域判定纠正）+ 实机走查。

---

## 1.4.5 —— 质量审计：代码质量 + 文档/roadmap 歧义点（已完成）

**缘起（2026-08-27 用户拍板）**：1.4.1-1.4.4 连续四个版本的增量（auto loop、域归位、研究档案）之后，按 1.3.10 审计方法过一版：代码级证据 + 实机驱动，产出台账分级（真 bug / 技术债 / 低危 / 记录在案），确认的逐条修复带回归测试；文档与 roadmap 的歧义点（过期口径、自相矛盾、失实描述）逐条修正。审计重点：1.4.4 新增代码（archive 全链 + GUI 分屏）+ 1.4.3 域归位 + 文档层。

- [x] **代码质量审计（服务端）**：1.4.4 新增面（archive.ts 实体/纠正/编号/渲染、research_archive 工具、注入段、admin 端点、报告投影）+ 1.4.3 域归位（resolveSessionDomain/能力清单）——逐条带证据（文件+行号）+ 严重度。
- [x] **代码质量审计（GUI）**：研究档案全链（model/archive、store 档案 slice、分屏布局、ResearchPanel、Stream 锚跳、TurnView 徽章、api 封装）——状态卫生、闭包陈旧、空态/异常兜底、死代码。
- [x] **文档歧义点普查**：docs/roadmap.md（当前线口径/落地记录/不做记录一致性）、docs/user-guide.md（1.4.x 新功能覆盖：auto loop/研究档案/分屏）、CLAUDE.md（命令与红线失实）、README（口径一致性）、docs/spec/design-spec.md 等历史稿的标注完整性。
- [x] **修复 + 回归**：确认的真 bug 修复带单测；文档歧义逐条改准；全量测试 + typecheck + eslint + 构建。

> 实际落地（2026-08-27）。**台账·真 bug（修，带回归测试）**：①`archive.ts::mutateArchive` 编号计数器混扫——R# 纠正条目污染 H#/V#/C#/Q# 起始序数（id 不冲突但无意义跳号，例：H#1 + R#2 后新假设变 H#3）→ 实体四类与纠正分扫（回归测试：R#1/R#2 后新假设恰为 H#2）；②`CORRECTED_STATUS` 缺 question 映射——人纠正未决问题时状态不翻转（保持 open，面板同时出现「打开」+「人纠正」徽章自相矛盾）→ 补 `question: 'abandoned'`（回归测试：人纠正 Q#1 → abandoned）；③交互 turn 的 `toolNames` 清单漏 `research_archive`（invoke 线有、交互线无，两线不一致）→ 补。
> **台账·低危（修）**：④admin `archive/correct` 空 id/空 reason 的错误文案（落进「实体  不存在」丑消息）→ 前置校验；⑤GUI `EMPTY_ARCHIVE` / `ENTITY_KIND_LABEL` 死导出删除。
> **台账·记录在案（不修）**：resolveQuestion 的 note 混入 links 字段（渲染侧均过滤，设计异味）；切环境瞬间档案单槽短暂展示旧线档案（chat:init 重锚即自愈）；rewind/fork 后 anchorMessageId 失效 → 跳流 no-op（不炸）；报告骨架截断预算不计 archiveMarkdown（实体量级极大时可超 48K，记录在案）；interactive/invoke 并发时锚点字段竞争（auto-run 锁输入实践不可达，anchorLabel 兜底）。
> **文档歧义修正**：user-guide 工具口径自相矛盾（目录写「四个工具」、标题写「七个工具」、表格 7 行）→ 统一「十个工具」并补 research_archive/request_decision/declare_completion；补「研究档案分屏看板 / auto loop 观察卡」读屏条目 + 「auto loop（1.4.1）」「研究档案（1.4.4）」两节 + 报告从档案派生说明。**CLAUDE.md 大修**（TUI 时代口径全面失实，AGENTS.md 的主开发文档指向它）：产品形态「无窗口/全屏 TUI」→「GUI 主窗口 + CLI」；桌面宿主行 GUI 窗口化 + tui_launcher 已删；后端/运行时 Node v24→≥22、「多实例 Sidecar」→单例；项目布局补 src/gui 行 + frontendDist 指向 src/gui/dist + index.ts 7.7k→3.8k；文档索引 TUI 规范改注退役；模型/MCP 的 TUI 命令行改 GUI 设置页；TUI 正门/鼠标捕获随删；tauri:dev 描述修正；转型节加追记；求助/反馈的 Claude Code 链接改本仓 issues。
> **验证**：新增 2 回归单测；全量 179 文件 2345 测试绿 + typecheck + eslint + 双构建绿。

> 不做（本版）：记录在案的五条低危（不强行处理）、CLAUDE.md 的 L1 红线总表重写（红线仍有效，本次只修失实描述）。
> 挂账待讨论（2026-08-27，用户拍板先记后议）：**研究档案问题（Q#）纠正语义裁决**——当前实现 a：纠正通道统一覆盖问题（纠正问题 → abandoned，纠正条目即放弃留痕）；备选 b：纠正严格限定断言，问题给独立「放弃」通道（语义洁癖，多一条交互）。b 若拍板需回退 a 并补放弃通道。**（2026-08-28 1.4.7 定稿：a 拍板——纠正问题即放弃，结案。）**

> 验收：全量测试 + 台账闭环（每条有定性：修复 / 记录在案）。
> 方法纪律：与 1.3.10 同——修 bug 必带回归测试；带证据（文件+行号）；记录在案的另行立项，不在审计版强做。

---

## 1.4.4 —— 研究档案：过程记录 + 成果汇总（已完成）

**缘起（2026-08-27 用户全程对齐）**：dogfood 反馈「和普通的 loop agent 没太大差异，反馈不够深入」追到根上——LLM 上下文有损（压缩丢、长会话漂移、反复重访死路），人脑装不下多小时复杂链路，**研究状态既不完整地活在模型里、也不完整地活在人脑里**。用户定框架：**研究 = 过程 + 成果；协同研究 = 过程记录 + 成果汇总；两者全程举证（成果怎么来的、过程怎么进行的，步步有据）；可推论（过程正推成果）、可反推论（成果倒查过程）、可纠正（定位错处、级联更新，不是覆盖）。** 研究档案就是这个状态显式存在的地方——不是给人看的反馈面板，是研究得以进行的前提，人机双方都操作它。

同版收束决策面板线（2026-08-27 用户拍板）：**决策面板现状确认无问题、一字不动**（其语义是**决策**——拍板，严肃、留档）；原候选「harness 拦截澄清提问」**砍掉**——澄清是**输入**（补信息），普通对话打字即交互、结构化通道无立足点，auto loop 的自主含义不允许中途向人要信息（信息不全由模型自己侦察发现；空转检测/验收终审已有兜底）。留档防复拾。

- [x] **档案实体与存储（服务端）**：实体层——假设（待验证/证实/证伪）/ 证据（有效/存疑/被推翻）/ 结论（类型：bug_class/原语/约束/事实；成立/存疑/被纠正）/ 未决问题（打开/已解决/放弃）；每实体三要素：**来源锚 + 状态 + 链接**（假设→实验→证据→结论正着通，结论→证据→假设反着通）；**纠正 = append-only 一等操作**（不删原文、下游打「待复核」不连坐，重新推论后可翻案——降权不删库纪律的档案版）；权威序：**人 > 专家知识 > 模型自证伪**；存储守 withFileLock + tmp+rename 纪律。
- [x] **锚层（harness 自动收割）**：transcript / 工具调用 / PoC 产物索引——举证的地基（「证据还有 PoC、LLM 轨迹」，零额外书写负担）；实体来源锚指向锚层，双向互跳的机械支撑。
- [x] **模型写档案**：归档工具（假设/证据/结论/未决问题/自证伪），research_log 契约不动（成败信号仍供蒸馏弧，与档案并存不混）；kernel 教学段教模型：假设驱动实验、**证伪同样留痕**（排除的路也是成果）。
- [x] **闭环注入**：每轮向系统提示词注入紧凑实时状态段（待答问题/当前假设/最新证据/待复核标记）——模型在显式状态上继续工作，不从历史脑补状态。
- [x] **GUI 分屏（研究看板）**：左流右档案默认 6/4、分隔条可拖、**左右可互换**；档案分区（待答问题/假设/结论/证据/证伪，新条目高亮，证据多时分区折叠 + 计数）；**行内纠正**（点结论 → 填理由 → 下游「待复核」徽章，不弹窗）；双向互跳（档案锚 → 流跳转；流内「→V3」归档标记反查）；<1280px 退回单屏 + 「研究」图标抽屉（未决问题数徽章，档案永不真正消失）；auto loop 下右屏为主观察面（观察卡保留当仪表）。
- [x] **报告投影**：exportReport 从档案派生——成果章节带 E#N 证据锚、过程章节含实验与证伪记录（**成果报告**而非「看的报告」，回应 1.2.0 遗留「报告只是一份看的报告，不是一份成果报告」）。
- [x] **验证**：全量测试 + 实机走查（dogfood 真实研究：档案随研究生长、纠正级联、双向互跳、报告派生）。

> 实际落地（2026-08-27）：①服务端 `loop/archive.ts`——四类实体 + append-only 纠正（状态翻转不删原文/下游待复核不连坐/人纠正终局拒模型翻案）、编号 H#/V#/C#/Q#/R# 独立递增、`<sessionId>.archive.json` 与 loop-sessions 同目录锁内读改写、注入投影（分组限量 + 1600 硬顶 + 收尾标签保底）与报告投影（研究结论带证据锚/证伪与纠正/未决问题/证据清单四节）两个纯函数。②`research_archive` 工具（7 操作，无条件注册）——锚层 = 当前轮 user 消息 id 自动捕获（headless 线置空）+ 模型自由标注；research_log 契约不动。③闭环注入——assemblePiSystemPrompt 按 turn 线装载档案，security/auto-run 场景注入 `<zhishi-research-archive>` 段；kernel 教学段并入（SECURITY_KERNEL_MAX_CHARS 2000→2400：修掉模板早已超顶被静默截尾的老账）。④admin 端点 archive/list + archive/correct（人纠正广播 archive:changed）+ SSE 注册表入册（字面量发射，双向对账钉死）。⑤GUI——model/archive.ts（事件归一/分组选择器/徽章计数）+ App 分屏（6/4 可拖可互换，<1280px 退单屏 + 「研究」抽屉按钮带未决问题徽章，localStorage 记比例/左右）+ ResearchPanel（分区/行内纠正/引用 chip 互定位/锚跳流）+ Stream 锚跳转 + TurnView「→V3」归档标记反查。⑥报告投影——skeleton 档案附录（纯事实不进叙述）+ export deps.loadArchive（交互与 auto-run 双线接线）。验证：新增 36 单测（server 28 + gui 8）；全量 179 文件 2343 测试绿 + typecheck + eslint + 双构建绿；链路活体（tsx 直跑：工具写→持久化→注入渲染→人纠正权威序→报告投影全通）+ 新 bundle 起服冒烟（archive/list 空档案返回、archive/correct 纠错路径正确）。实机走查（GUI 分屏/行内纠正/互跳）待用户验收。

> 不做（本版）：决策面板任何改动（现状确认无问题）、澄清提问结构化（已砍）、跨会话档案（蒸馏弧职责）、档案图化（攻击链图，后续候选）、报告脱敏增强。
> 验收：全量测试 + 实机走查（真实研究场景档案全程活体）。

---

## 1.4.2 —— 实机反馈修复（已完成）

用户实机反馈四项（2026-08-26，auto loop 发版后使用中发现）：

- [x] **登记按钮字号**：本机已有行的「登记」按钮字体过大不协调——改小号 muted 样式（10.5px 细边框），与行内徽章一致。
- [x] **侧栏底部入口恒可见**：环境多时列表溢出把「＋新建环境」「⚙设置」挤出可视区——列表区包滚动容器（`.eb-scroll` flex:1 overflow-y:auto），底部入口 flex-shrink:0 恒定在底部。
- [x] **决策面板选项卡片化**：「还是会出现让用户选择输入选择，而不是选择卡片」——选项从「小字行 + 两步提交」改为**大卡片按钮单击即拍板**（a/b/数字键等价）；输入降级为折叠的「选项都不对——自定义应答」次要通道；autofocus 落到第一个选项卡。
- [x] **窗口自适应**：去掉 `.shell` 的 1400px 宽度上限——应用填满窗口，配合侧栏滚动修复，缩小窗口不再破版。

> 实际落地（2026-08-26）：四项全落（EnvSidebar/DecisionModal/styles.css），gui 388 测试绿 + typecheck + eslint + build:gui 绿。实机走查由用户确认。

---

## 1.4.1 —— auto loop agent（已完成）

设计依据：`docs/design/auto-loop-design.md`（2026-08-26 定稿，用户拍板全部细节）。**目标式 + 研究阶段进度锚**：研究员给目标，agent 自主跑完整研究周期，人在暂停点介入。同版决策：**/bg 转后台砍掉**（auto loop + env_bg 全覆盖其价值）。

- [x] **启动表单**（GUI 模态，决策面板同族样式）：任务名 / 环境（启动即锁定）/ 目标 / 预算三选一（轮次/token/时间，默认保守）/ 验收条件自由文本多条（必填 ≥1，启动即锁定）/ 开局快照（默认开）/ 完成报告（默认开）。
- [x] **auto-run runner**（服务端）：表单落盘（auto-run 记录可追溯）→ 复用 invoke 通道（独立 loop 线，不污染主会话）→ 每轮结束自动发起下一轮 → 暂停点挂起等响应 → 达成/终止收尾；研究阶段进度锚（1.2.7 阶段框架升级为进度状态机，阶段边界拍肩膀回报）。
- [x] **暂停点两层**：模型主动（越界 boundary-ask / 分歧 request_decision，已有机制接上）+ harness 被动新增（空转检测连续 6 轮无新增有效研究记录且阶段未推进 → 提请；同类工具连续 3 次 isError → 提请；预算耗尽 checkpoint + 提请续命）。
- [x] **运行期交互**：运行中不可输入（steering 关闭）、不可切环境（环境锁定）；Esc = 终止 loop（会话保留回普通模式）；暂停点复用决策面板。
- [x] **达成与验收**：验收包 = 条件 × 证据（E#N 研究记录引用）+ 模型陈述；人终审（通过 / 不通过 / 继续跑）；达成后自动出报告。
- [x] **SSE 事件族**：auto-run:started / phase-changed / turn-completed / paused / budget-warning / completed / verdict-requested——注册表 + crosscheck 双向对账（1.3.10 纪律）。
- [x] **GUI 观察界面**：运行中卡片（阶段/轮次/预算余量/最近结论行/Esc 提示）+ 验收包模态。

> 实际落地（2026-08-26）：服务端——`loop/auto-run.ts`（runner 1387 行：AutoRunRecord 存储 withFileLock+tmp+rename、循环复用 invokePiSession（新增 `{type:'auto-run'}` 交互场景，headless 同族）、暂停点判定纯函数（空转=连续 6 轮无新增有效研究记录且阶段未推进，阶段复用 1.2.7 segmentContext 末段相位；反复失败=同类工具 isError 连击≥3；预算=轮次/time/tokens 三档，tokens 用 estimateMessageTokens 启发式）、暂停恢复混合机制（stop/budget/verdict 事件驱动 wake；决策注入走轮询 pendingDecisions+decision marker，上限 10min 兜底）、预算耗尽 checkpoint（快照 best-effort）→ 提请续命（auto-run/budget，仅 paused+budget 态））+ `declare_completion` 工具（达成声明注册表按 loop 线分桶 take 即消费）+ 5 端点（start/stop/budget/verdict/list，start 校验 env 存在+criteria≥1+limit>0，同 workspace 单活跃 run；verdict 仅 awaiting-verdict 态，pass=自动出报告复用 exportReport，fail/continue=注回线续跑）+ SSE 7 事件（crosscheck 双向对账过）。GUI——启动表单（任务名/环境**锁定当前环境不可选**（走查追加拍板）/目标/预算三选一/验收条件多条）+ 观察卡（阶段/轮次/预算余量进度条/最近结论行/Esc 提示；budget 暂停内嵌续命输入；stall/反复失败提示决策面板作答）+ 运行期锁定（输入区禁用/切环境 toast 拦截/Esc 二次确认终止）+ 验收包模态（条件×证据预检+三按钮）+ reducer 7 事件归约 + Esc 链 verdict/autoRunActive 层。新增 69 单测（server 30 + gui 39）；全量 177 文件 2308 测试绿 + typecheck + eslint + 双构建绿；实机走查通过（用户确认）。交叉收口：GUI 路由对齐 admin 通道（adminPost auto-run/*）、stall/反复失败恢复走 harness 提请的决策面板（verdict continue 仅限 awaiting-verdict）、表单快照/报告开关移除（服务端无条件执行）、vmware rm 测试改不存在的 vmx 路径去环境依赖。

> 不做（本版）：范围边界（后置）、/bg 转后台（已砍）、引擎单例残余耦合（纯技术债，无 2.0 绑定——「引擎多实例」2026-08-27 随 2.0 范围砍单，另行立项）、god file 拆分（记录在案）。
> 验收：全量测试 + 实机走查（dogfood 一个真实目标跑通：启动表单 → 阶段推进 → 暂停点 → 验收终审）。

---

## 1.4.0 —— GUI 正式发版（已完成）

1.3.x 线收官：GUI 覆盖核心场景（1.3.0-1.3.8）+ TUI 退役（1.3.9）+ 全局质量审计（1.3.10）全部完成。本版=**退役后的首次发版**：编译打包 GUI 版 + 发版前全量回归 + 合 master + 发布。遗留的「发版前」三件在这里收口。

- [x] **打包收口三件**：①node-pty 打包侧 pty-runtime 接入（`src-tauri/resources/pty-runtime/`，sqlite-runtime 同款模式——@lydell/node-pty 平台 prebuilds 进资源，`loadNodePty` 的 `<Resources>/pty-runtime` 回落路径已就位）；②Tauri 生产路径 WS upgrade 转发验证（attach 终端 `/api/admin/environment/term` 在打包形态经 Rust panel_api 代理的可达性——1.3.3 记录在案「未验证」，不通则终端模式降级一次性执行）；③esbuild server 外部依赖（node-pty/ws）在打包 server-dist.js 的 require 路径核验。
- [x] **编译打包**：NSIS 安装包 + 便携 ZIP（scripts/build/build_windows.ps1 全链路，1.2.3 链路沿用：bin 三件套 + PATH 注册 + 卸载）；GUI 窗口 + sidecar 生命周期 + cli_launcher 镜像 + zhishi.cmd 生成式。
- [x] **发版前全量回归**：全量测试 + typecheck + lint + 三构建 + cargo clippy；打包产物实机安装验证（装完：GUI 开窗、环境列表、会话流、attach 终端、模型配置、zhishi 命令、三入口聚焦、卸载）。
- [x] **版本号 + CHANGELOG**：1.4.0 release（sync-version 流程：tauri.conf.json + Cargo.toml）；CHANGELOG 1.4.0 条目（GUI 正式版 = 1.3.0-1.3.10 全部内容摘要）。
- [x] **合 master + 发布**：合并到主分支，GitHub Release 上传安装包（README 已是 GUI 口径）。

> 实际落地（2026-08-26）：打包收口——pty-runtime 接入（build_windows.ps1 预装段：@lydell/node-pty napi 预编译件无需 ABI 重编；tauri.conf 资源条目；patch_nsis 安装/卸载；本地预演通过）+ WS upgrade 核验（ws 库 noServer 模式默认不校验 Origin，生产直连可通；实机 attach 验证到 ssh spawn 成功）+ esbuild external 核验（node-pty 运行时 require + pty-runtime 回落路径就位）。四次构建迭代：①首轮成功（NSIS 107.94 MB + ZIP 62.39 MB）但抓出 **build_windows.ps1/install-cli.ps1 的 UTF-8 BOM 丢失**（1.2.10 老坑复发：PS5.1 中文注释解析崩溃）——补 BOM 重跑；②抓出 **PATH 安装的 zhishi 独立不可用**（只认 ZHISHI_PORT 不读 sidecar.port）——补端口回落（活体：无端口 env list 通）；③抓出 **侧栏状态陈旧拦进入**（手动开机/刚启动时 ps 快照旧）——点击重探 + 侧栏头部 ⟳ 手动刷新；④用户补需求 **host 态禁发消息**（一切操作都在环境内——未锚定环境输入区禁用 + send 前置闸 toast）。实机安装验证通过（用户确认）：GUI 开窗、环境列表/能力徽章、点击重探进入、attach 终端（VM 在线）、`zhishi env list` 无端口独立可用、卸载（目录/PATH 清理）+ 重装。版本 1.4.0（package.json/tauri.conf/Cargo.toml 三处同步）+ CHANGELOG。全量 173 文件 2225 测试绿 + typecheck + eslint + 三构建 + cargo check 绿。

> 验收：全量测试 + 打包产物实机安装验证（装完点图标开 GUI → 走一遍核心链路）。
> 里程碑意义：1.3.x GUI 主线完成后的第一个正式发行版——TUI 时代终结，GUI 时代开始。

---

## 1.3.10 —— 全局代码质量审计（已完成）

用户定调（2026-08-26）：发版（1.4.0）前的全局代码质量审计。方法论同 1.2.8 TUI 普查 / 1.3.8 环境普查：代码级证据 + 实机驱动，产出台账分级（真 bug / 技术债 / 低危 / 记录在案），确认的逐条修复带回归测试。

- [x] **审计四域**：①服务端（src/server/——god file 状态、chat-engine 模块级单例、文件 IO 纪律 withFileLock、错误处理/降级一致性、死代码、SSE 契约完整性）；②GUI（src/gui/——store 状态卫生、reducer 对 SSE 事件族覆盖、组件/样式死代码、异常兜底）；③CLI（src/cli/——TUI 退役后的剩余面：expert/intel/term 子命令、死代码）；④Rust（src-tauri/——tui_launcher 退役后的残留、panel_api/terminal/cli_launcher 边界、三入口一致性）+ 共享类型（src/shared/）。
- [x] **台账与定性**：逐条带证据（文件+行号）+ 复现路径 + 严重度排序；真 bug 修，技术债分级（本版可修的低风险债 vs 记录在案的大重构——god file 拆分等绞杀式随做随拆，不在审计版强行执行）。
- [x] **修复 + 回归**：确认的 bug/低风险债修复，带单测；全量测试 + typecheck + eslint + 构建 + cargo check。

> 实际落地（2026-08-26）：四路审计 60+ 条台账，修 22 项。服务端 10：A1 invoke 通道越权广播（标题钩子/bg-finished 改静默，单测钉死「invoke 零广播」）；A2 SSE 孤儿事件清表 27 条 + crosscheck 双向对账（broadcast 变量名路径纳入扫描）；C1 过期注释（exit_cron_task/agent-session/TUI 措辞）；C2 /chat/send 状态码按错误类别区分（配置缺失 400/其余 429）；C3 两处 recoveryHint 补齐；#1 迁移引用改名失败持久化 pending 自愈（锁冲突场景单测）；#2 删 environment/remove 死路由双语义（CLI env remove 别名改指 rm）；#3 ps vmware 收敛 resolveVmxForEntry；#4 capability 双实现空 surface 等价钉死；#6 memory search 类型守卫。GUI 7：G-01 模型 overlay 打开重拉（「显示=可运行」契约修复）；G-02 BootModal Esc 拦截（文案与行为对齐）；G-03 删 4 死函数；G-04 reducer 死分支；G-05 esc/closeModal 语义统一；G-06 refreshSidebar 代次治理（过期快照丢弃）；G-09 版本常量。CLI+Rust 9：B1 CLI_COMMANDS 补 6 组（env/domain/research/intel/expert/help——`ZhiShi.exe expert list` 不再静默吞）；B2 删 4 死条目；T5 lib.rs 死代码；L1-L4 注释口径（tui_launcher 引用/tray 矛盾/Bun→Node/失实注释）；L6 macOS Reopen 复用；T3 zhishi.cmd 死拷贝链删除。另：四文件双倍行距归一化（-11.4K 行噪音，独立 commit）+ CLI help 路由/env remove 别名（活体验证）。红线核验：SSE 注册表双向对账强化（L400）、withFileLock 纪律、修 bug 必带回归测试、depcruise 边界干净（顺带消除旧 no-orphans 警告），无违规。链路活体：environment/list、capability-refresh 回写（binary，按现场推导）、model/list current、sessions、queue/status、domain/list、health/ready 全通。全量 173 文件 2225 测试绿 + typecheck + eslint + build:cli/server/gui + cargo check 绿。**记录在案**（另行立项）：god file 拆分、原子写 helper 迁移、zhishi.ts 主体单测、双终端栈合并评估、SSE 对账专项（G-13/G-14/G-21 等漏面）。

> 不做（维持）：编译发版（1.4.0 发版版做）、大规模重构（god file 拆分/引擎单例解耦——审计记录，重构另行立项）、/bg 转后台（单独立版）、新功能。
> 验收：全量测试 + 实机走查。

---

## 1.3.9 —— TUI 退役执行（已完成）

执行依据：`docs/design/1.3.4-tui-retirement.md`（评估报告，用户已拍板退役时点=1.3.9）。GUI 三块核心（会话+决策+历史）与全部补缺（1.3.5-1.3.8）已齐，交互式 TUI 停运条件成立。**口径：退役交互式 TUI（渲染层+app 装配），`zhishi` CLI 子命令与 `zhishi term` 链路（Rust panel_api）独立存活，勿误删**。

- [x] **摘除 src/cli/tui/ 全目录**（产品 ~7.9K 行 + 27 测试文件）：渲染层/event-reducer/gate/editor/keymap/blocks/slash/attach 等；`zhishi.ts` 摘 bare `agent` 分支（`runAgentLoop` import、:3104-3141 分发、TOP_HELP 交互行、--env/--new-env 描述）——`zhishi agent` 子命令保留，无参数改为打印引导 + 非零退出码（防 AI 调用方误判「会话已启动」）。
- [x] **Rust 壳三入口切换**：删 `src-tauri/src/tui_launcher.rs`；`lib.rs` single_instance 回调 → 聚焦主窗口、setup 交互启动块 → 显示主窗口（`sync_cli_resources` 镜像逻辑保留/搬家）、模块声明删除；`tray.rs` `open_session` → `show_main_window`。**三入口同批切换，漏一处=桌面入口失活**（报告最高风险）。
- [x] **服务端注释措辞**：index.ts / admin-api.ts 的「TUI」注释改「客户端/GUI」（零行为改动，SSE 契约全共享）。
- [x] **文档/资产改写**：README.md（TUI 口径 → GUI 主界面 + 截图替换）、user-guide.md §5「TUI 操作大全」改写为 GUI 操作、tui_tech_spec.md / tui-rebuild-plan.md 标注「已退役，历史归档」、bundled-skills/zhishi-cli/SKILL.md:269 更新、package.json description 更新。
- [x] **验证**：全量测试（删 TUI 测试后基线下降属预期）+ typecheck + eslint + build:cli/server/gui + `cargo check`；实机走查：三入口（点图标/托盘/二次实例 → GUI 窗口聚焦）、`zhishi term open/write/read/close` 回归、bare `zhishi agent` 行为、GUI 重连 SSE。

> 实际落地（2026-08-26）：`src/cli/tui/` 全目录删除（测试基线 196→171 文件、2524→2204 属预期——TUI 25 测试文件随目录走）；`zhishi.ts` bare `agent` 分支改「打印引导 + exitCode=1」，TOP_HELP 示例改 agent list，`agent` 子命令（list/show/enable/disable/set）原样保留。Rust：`tui_launcher.rs` 瘦身改名 `cli_launcher.rs`（保留 `sync_cli_resources` + zhishi.cmd 生成式烘焙，删 `spawn_open_tui/open_tui_session/默认工作区/终端拉起` 全套）；`lib.rs` 三处（模块声明、single_instance 回调 → `tray::show_main_window`、setup 交互启动块）；`tray.rs` `open_session` → `show_main_window`。**实机抓出真 bug**：删 TUI 启动器把「交互启动拉起全局 sidecar」的隐藏职责也删了——GUI 的 `get_sidecar_port` 只读端口文件不拉起，环境列表永不加载；修复：交互启动恢复 `start_global_sidecar`（spawn_blocking 内，reqwest::blocking 纪律）+ 显示窗口（--minimized 三件都不做）。注释措辞：server 8 处「TUI」→「客户端/GUI」；zhishi-cli SKILL.md「进环境干活」条；package.json description。文档：README 全面改写（GUI 控制面/架构图/模块表/快速开始/验证状态/文档表）+ user-guide §1-5 改写（GUI 操作+快捷键+读屏幕，CLI 命令大全保留）+ tui_tech_spec/tui-rebuild-plan 顶部加退役归档横幅。全量 171 文件 2204 测试绿 + typecheck + eslint + build:cli/server/gui + cargo check 绿；实机走查通过（用户确认：三入口聚焦 GUI、无 TUI 拉起日志、环境列表正常、bare agent 引导）。

> 不做（维持）：编译发版（GUI 完成前——打包冒烟发版版做）、B 形态引擎并行（已砍）、/bg 转后台（单独立版）。
> 验收：全量测试 + 实机走查。

---

## 1.3.8 —— 环境/配方深入 + BUG 普查 + 环境多配方（已完成）

用户定调（2026-08-26）：深入环境、配方的功能实现与 GUI 调用实现，寻找 BUG，环境多配方。1.3.7 把环境业务逻辑收干净后，本版把环境与配方两个对象的功能面做深。**讨论收敛 + 用户拍板（2026-08-26）：范围收窄——配方管理不做 GUI 化（配方是开发资产）、环境行不加详情抽屉/操作面板（违背信息不堆砌）**。

- [x] **停止（down）入口 + 三态判定统一**：侧栏运行中环境加停止（确认模态，VM 关机/容器停是有损操作）；运行中/已停止/本机已有三态判定收口成一个纯函数（ps/discover/registry 三源合一）。
- [x] **环境/配方 BUG 普查**：up/down/ps/discover/snapshot/rollback/exec/rm/adopt/build 的边界 + GUI 接线，实机驱动 + 代码审查，产出 bug 台账逐条定性修复（方法论同 1.2.8 TUI 普查）。
- [x] **环境多配方**：`recipeIds?: string[]` 关联侧——绑定=展示/构建来源，**不进域裁决**（能力集合=推导唯一真相源，1.3.7 场景 3 口径）；环境详情可管理配方绑定（加/减）；存量零迁移（recipeId 单值自动等价单元素集合）。组合构建另行评估，不做。
- [x] **配方透明化两件（轻）**：向导里 VM/docker 生命周期差异显性化（一次性 vs 持久可回滚）；配方方法教学（SKILL.md 打法 workflowSummary）默认折叠可见。

> 实际落地（2026-08-26）：①停止入口——侧栏运行中行 ⏹（ssh 行不出，B12 联动）+ 确认模态（VM 关机/容器停止并移除警示）+ `environment/down`；三态判定收口 `resolveEnvState`（ps/discover/registry 三源 → running/stopped/unregistered + startable/registeredAs，groupSidebar/向导/准入闸同源）。②BUG 普查台账 15 条（6 真 bug + 9 低危），修复 8 条：**B1** docker 双身份（ps 短 id ↔ 条目容器名归一回联 + GUI psRowMatchesEntry）；**B2** hyperv/vbox 已登记条目 rm 承诺与行为相反（vmx 解析不出回落实体删除）；**B3+B12** ps 手动探测读 host+port（ssh 永远已停止修复）+ ssh 停止入口隐藏/服务端明确报错；**B4/B5** hyperv ps 加 Running 过滤与 discover 全量枚举拆双函数（vmware 全量枚举无 API 保留运行中口径注明）；**B6** docker up 按 label 幂等；**B7** ps 双行去重；**B15** 删 SshModal/submitSsh 死代码。留台账：B8-B11（select 校验/rm 清 selection/add 探测前置/legacy remove 分叉）下版本清；B13/B14 业务特性文档化。③环境多配方——`EnvironmentEntry.recipeIds[]`（含主配方、主配方不可减）+ registry 校验 + `environment/bind-recipes` 端点（整体替换、主配方恒在、best-effort 重推能力）+ up 回写初始化 `[recipe.id]` + 能力清单段绑定集合工具并集 + GUI 环境详情模态（ℹ 入口：定位锚/地址/私钥引用/能力/漂移 + 绑定 chips 加减、主配方 ⓟ）+ env-recipes 纯函数层。④配方透明化——向导生命周期说明（一次性容器 vs 持久 VM）+ workflowSummary 折叠展开（端点本就透传，server 零改动）。走查追加：侧栏视觉重构（环境名主位满宽、能力徽章短形态最多 2 域 +N、行操作收进 ⋯ 下拉菜单带文字标签——不再依赖悬停提示）。新增单测 42（server 27 + gui 15）；全量 196 文件 2524 测试绿 + typecheck + eslint + build:server/gui 绿；实机走查通过（用户确认）。

> 不做（收敛后）：配方页签/详情页/编辑（配方是开发资产，管理走 CLI）、环境详情抽屉/行级操作面板（违背信息不堆砌）、组合构建、用户改配方（另行立项）、编译发版（GUI 完成前）、TUI 退役执行（1.3.9）、/bg 转后台（单独立版）。
> 验收：全量测试 + 实机走查。

---

## 1.3.7 —— 环境业务逻辑：讨论 + 优化（已完成）

用户定调（2026-08-26）：环境与环境创建的业务逻辑现在很乱，本版先讨论后迭代。三个场景 + 调研结论：**用户拍板（2026-08-26）：三场景全做，场景 3 选 B 方案（纯系统推导，域不进用户界面），顺序 2→1→3，实现完成后直接推送，无需中途确认**。口径修正：「自动切换环境」改为「自动切换域（注入面）」，执行宿主始终人选定不切。

**现状证据（2026-08-26 调研，代码级）**：
- 环境→配方→域是**单向单线**：`EnvironmentEntry.recipeId` 单字段（config-types.ts:1198）→ 配方（recipes.ts）→ domain.json 反查首命中 → 域是**单值**注入面（system-prompt-security.ts:451-478）。**无多能力环境机制**。
- 「自动切换环境」**从未存在**——历史决策里自动切换的只有**域**（1.2.7 `resolveSessionDomain`：配方默认 + 内容信号动态修正，20 条消息防翻转窗口；只改 skills/capabilities/subagents/研究记忆注入面）。env_exec 的执行宿主由 `environment/select` 绑定，切域**不换**执行环境。
- vm 条目**双 id 模型并存**：vmware「模板即环境」（id=recipe.id）vs hyperv/vbox「实例即环境」（id=实例名），down 靠 id 后缀启发式路由——同一 kind 两套语义。
- 建环境入口**七路径无统一向导**：docker 配方 up / VM 配方 up / VM adopt / VM build（仅 CLI）/ 本机发现登记 / ssh 手动 / 通用 add；GUI/TUI/CLI 三端能力面不一致（build 与 up --vm-base 在 GUI 无入口；ssh 表单丢 port/name/osFamily/recipeId 字段——手动 ssh 条目永无配方绑定，域只能靠信号猜）。
- 「recipeId 回落同名配方」规则三处复制；「运行中」判定四引擎拼装无统一状态机；发现→登记映射两端自拼不一致。

- [x] **讨论一：环境归属模型**——用户场景「我已有 VM 系统，它属于哪个环境？」：现状 VM 机器=环境条目 1:1（vmware/hyperv 两套语义）。议题：是否引入「机器（machine）↔ 环境（environment）分离」或至少统一 vm 条目语义；已有 VM 的归位路径（discover/adopt/register）要不要收敛成一个「接入已有环境」统一流程。
- [x] **讨论二：新建向导分步化**——用户场景「新建环境应该一步一步往下选择」：七路径收敛为「选来源类型 → 分步参数 → 确认 → 构建/接入 → 完成」的 GUI 向导（docker 配方 / VM 配方 / 接入已有 VM / 本机发现 / SSH 手动五类型），环境多时不乱。同时补 ssh 表单缺的字段（port/name/osFamily/recipeId）。
- [x] **讨论三：多能力环境**——用户场景「一个环境需要承载多个能力，现在不允许」：数据模型 `recipeId` 单值 → 环境可声明多配方/多域（如 `recipeIds[]` 或 `domains[]`，含主域/默认域）；与 1.2.7 域判定衔接（域信号在环境声明的能力集合内切换，集合外强信号才提请）；「自动切换环境」口径澄清为「自动切换域（注入面），执行宿主不自动切」。

> 实际落地（2026-08-26）：**场景 2（GUI 新建向导）**——四步向导（选来源 docker 配方/VM 配方/本机已有/手动 SSH → 按类型收参全默认可跳 → 确认页展基底/配方/工具清单/域绑定 → 执行复用 BootModal 轮询），SSH 补 port/name/osFamily/recipeId（recipeId 让手动 ssh 也能绑域），model/env-wizard.ts 纯状态机 21 例。**场景 1（vm 语义统一+迁移）**——vm 条目统一「实例即环境」（id=vmName，vmx 降级纯定位；vmware「模板即环境」废除，up 回写实例条目）；id→vmx 解析收敛为 `resolveVmxForEntry`（条目 vmx 优先 → vmTemplates 探测回落），删「id 以 .vmx 结尾」启发式路由；存量迁移 `vm-entry-migration.ts`（锁内重读重算 + tmp+rename + .bak + 幂等，同步迁移 env-sessions/selection 引用）；GUI 接入 payload 收敛（buildRegisterPayload 一处，vm id=vmName+ID_PATTERN 净化）+ adopt 入口改到向导 VM 步骤次级按钮（模板养成与环境接入分开）。**场景 3（多能力环境，B 方案纯推导）**——capability-derive.ts：工具→配方→域反推表（67 个 bundled 工具）+ 批量探测（复用 buildToolCheckScript 一次 exec，绑定域恒在集合不需探测证据）+ `EnvironmentEntry.capabilityDomains/capabilityDerivedAt` additive 落盘（up/add/capability-refresh/domain-check 四处计算，探测失败不写字段不误判空集合）；域推导链收窄：基线=capabilityDomains[0] ?? 旧链，信号裁决只统计集合∪基线内域（集合外强信号不切，阈值不变，存量零迁移行为逐字节不变）；能力清单段注入推导集合+工具并集+漂移标注；GUI 侧栏能力徽章+⟳刷新按钮+向导确认页推导集合行。实机抓出：旧 submitSsh 的 `user@host` id 过不了 registry 校验（向导净化规避）。新增单测 45（server 37+gui 8，含场景 1/2 的 21+22）；全量 190 文件 2438 测试绿 + typecheck + eslint + build:server/build:gui 绿。**活体验证（curl 直连 sidecar）**：启动迁移日志「vm-entry migration done」、`environment/list` 新字段在线、`environment/capability-refresh` 对 pwn-vm 真探测回写 `["binary","ai-security","pentest","whitebox"]`（按现场工具推导）并持久化。

> 实机走查驱动追加（2026-08-26，用户验收通过）：**环境删除补齐**——服务端 rm 扩 ssh/docker 摘登记（docker 容器在跑拒绝，探测失败放行；既有 vm/hyperv/vbox 语义不动）+ GUI 删除入口按驱动分级文案（ssh/docker/vmware 轻确认摘登记；hyperv/vbox 红警示+输名确认永久删除；运行中拦截先停止）。**本机发现去重**——matchRegisteredEnv 按 vmx 归一化/vmName/container/id 匹配，已登记条目标「已登记为 X」徽章禁重登，向导步骤同步禁选。**登记补连通信息**——VM 条目登记补 address/user/keyPath（address 必填，exec 通道前提），registry 校验原已支持纯接线。**删除/启动按钮图标化**（🗑/▶）。**实机抓出 rm 的 .vmx 守卫误伤**：id 以 .vmx 结尾的已登记条目（旧发现登记流形态）被「.vmx 直传拒绝」误伤——守卫改到登记条目查询之后（回归测试锁定）。全量 192 文件 2465 测试绿 + typecheck + eslint + 双构建绿；实机验收通过（用户确认）。

> 不做（维持）：编译发版（GUI 完成前）、TUI 退役执行（1.3.9）、/bg 转后台（单独立版）。
> 验收：全量测试 + 实机走查（讨论结论落地后）。

---

## 1.3.6 —— 实机反馈修复（已完成）

1.3.5 走查后的用户反馈六条（2026-08-25），本版逐条修：

- [x] **①输入框点击热区**：输入框只有一半能点击——InputArea 点击区域被相邻元素/透明层覆盖，修复为整行可聚焦。
- [x] **②历史会话从侧边栏移除**：侧栏底部「▤ 历史会话」入口移除（工具栏「▤ 历史」保留为唯一入口）。
- [x] **③MCP 置灰占位**：MCP 设计未定——设置页 MCP 页签保留位置但**置灰不可点击**，页签内容改「设计待定」占位（代码保留待后续启用）。
- [x] **④情报更新修复 + 模式说明**：a) 修「数据会丢失」——追踪 IntelTab 更新链路与 `intel/config-update`（1.3.2）的读改写，定位丢数据根因并修（服务端或 GUI 侧以证据为准）；b) `minimal/window/full` 三个模式名换成中文标签 + 说明文案（语义以服务端实现为准：window=时间窗口裁剪；minimal/full 的注入差异读实现后写准确文案）。
- [x] **⑤skills/expert 导入改文件选择**：导入不再手输路径——引入 tauri-plugin-dialog（src-tauri 首次 GUI 期改动：Cargo.toml + lib.rs 注册 + capabilities 权限 + src/gui 的 @tauri-apps/plugin-dialog）；skills 导入选**目录**（透传 import-folder）、expert 导入选**文件**（读内容解析后走既有 expert/add 链路）；浏览器无 Tauri 环境降级为 HTML 文件选择（webview 走查不受影响）。
- [x] **⑥模型选择只显示已配置**：状态栏模型切换器过滤未配 key 的 provider 模型（与 1.2.9 运行链路同口径——显示=可运行）。

> 实际落地（2026-08-25）：①输入框根因是**几何错位非遮挡**——48px 盒子 textarea 只占底部 24px，上半部死区；修：input-box 整行 onClick 聚焦 + cursor:text。②EnvSidebar 底部入口删（工具栏保留）。③NAV mcp 项 disabled 置灰（.disabled 样式 no-op 点击）+ McpTab 换 StateHint「设计待定」占位；model/mcp.ts 与测试原样保留。④**丢数据真根因在同步链不在 PATCH**：window 模式更新末尾 `pruneByWindow` 无条件删窗口外存量 CVE，且水位机制导致切回 minimal/full 只增量同步、裁掉数据永久不可恢复——修：`pruneWindow` 仅当持久化配置已提交 window 才裁剪（一次性档位覆盖只过滤不删）+ sync 单测锁定；GUI mode 初始值 'window'→'minimal'（服务端缺省）+ payload 构造抽纯函数（8 例含 falsy 不丢）；三模式中文标签按实现如实写——精简/全量当前行为一致（sync 层未做最小化存储）、时间窗口=窗口内过滤+提交后裁剪存量（含警示文案）。⑤tauri-plugin-dialog 2（Cargo.toml+lib.rs+capabilities），skills 选目录回填路径、expert 走文件输入+FileReader（fs 插件未在范围，dialog 只回路径），浏览器回落 webkitdirectory/input。⑥model/list 的 hasApiKey 直接消费（1.2.9 服务端已算好），当前生效模型保留显示。**实机走查抓出真 bug**：capabilities/default.json 的 `"windows": []`（无窗口时代遗留）导致 webview 全部 IPC 被拒、dialog 无反应——改 `["main"]`（GUI 首个 IPC 依赖，此前纯 HTTP 从未暴露）。新增 GUI 单测 18（intel-config 8/model-picker 7/tauri-env 3）+ server 2；全量 186 文件 2349 测试绿 + typecheck + eslint + build:gui + cargo check 绿；实机走查通过（用户确认）。

> 不做（维持）：编译发版（GUI 完成前）、TUI 退役执行（1.3.9）、/bg 转后台（单独立版）。
> 验收：全量测试 + 实机走查。

---

## 1.3.5 —— GUI 补 4 项 + TUI 瘦身（已完成）

1.3.4 退役评估的去留清单拍板执行（2026-08-25 用户拍板）：**GUI 补 4 项 + TUI 砍 8 项瘦身**（TUI 退役执行留 1.3.9）。

- [x] **GUI 补 ①输入历史落盘 + 模糊评分**（轻）：移植 TUI `history.ts` 的子序列评分纯函数；GUI 输入历史按环境落盘（localStorage，per-env 键）→ 重启不丢；Ctrl+R/↑↓ 历史 overlay 换模糊评分（现为 includes）。
- [x] **GUI 补 ②`/export sanitize`**（轻）：export 斜杠路由支持 `sanitize` 参数（对齐 TUI `slash/report.ts:22-53` 语义，透传 `report/export` payload）。
- [x] **GUI 补 ③设置页 MCP 管理**（中）：设置页加 MCP 页签（`mcp/list` + 状态 + `enable|disable` + 热重载端点接线；卡片逻辑可移植 `src/cli/tui/v2/model.ts:159-239`）。
- [x] **GUI 补 ④本机发现「选中即注册」**（轻）：侧栏「本机已有」未注册行加「登记」动作（`environment/add` → 入侧栏 + 可切换）。
- [x] **TUI 瘦身（砍 7 项实删）**：①`/attach` 宿主终端挂起（slash 命令 + attach.ts + entry.ts 挂起/恢复接线——GUI AttachView 已更强）；②`/env` 重进正门（侧栏替代）；③`/quit`（Ctrl+C/SIGINT 仍在）；④`--env`/`--new-env` flag 直通（zhishi.ts 分支，改打印引导）；⑤状态栏 token 计数段；⑥Esc 草稿恢复槽；⑦Ctrl+L 帮助面板。**bracketed paste/kitty 协议解析保留到 1.3.9**（报告 §3.2 原文即「随渲染层整体退役」口径——是输入正确性依赖，非功能面，1.3.5 不碰）。TUI 相关单测同步更新，行为变化记录在案。

> 实际落地（2026-08-25）：GUI 补四项——①输入历史 per-env localStorage 落盘（`zhishi.gui.inputHistory.<envKey>`，读写异常静默同 theme 纪律）+ TUI history.ts 子序列评分逐字移植（model/input-history.ts，20 例）；②/export sanitize（slash-routes optional-name + payload 透传，服务端语义核实：sanitize===true 生效、响应 degraded 实为 string[] 修正 api 类型，2 例）；③设置页 MCP 页签（mcp/list+list-status+enable|disable+reload 四端点接线，composeMcpRows 移植 TUI 合成语义，toggle 后补 reload——服务端 toggle 只写盘不重载桥，10 例）；④本机发现登记（docker/vmware/hyperv/vbox 载荷构造，运行中才自动切换——停着条目只入侧栏防死线，5 例）。TUI 瘦身——/attach（attach.ts+slash/attach.ts+entry 挂起恢复接线全删）、/env（连带 gate reentry 死代码清理）、/quit（退出=正门 Esc/空闲 Ctrl+C/SIGINT，hint 与欢迎卡更新「Ctrl+C 退出」）、--env/--new-env（残留打印引导）、token 段、Esc 草稿槽、Ctrl+L 帮助面板（/help 改列命令）；21 文件净 -834/+82、删 4 文件、测试 -15（381 绿，含 app 级字节链路锁定退出路径）。全量 183 文件 2329 测试绿 + typecheck + eslint 零错 + build:gui/build:cli 绿；GUI 实机走查通过（用户确认）；TUI 活体未跑（用户拍板：381 单测覆盖足够，砍项纯删除无新逻辑）。

> 不做（维持）：编译发版（GUI 完成前）、TUI 新功能（冻结——本版只删不加）、B 形态引擎并行（用户已砍）、/bg 转后台（单独立版）、TUI 退役执行（1.3.9）。
> 验收：全量测试 + 实机走查（GUI 补项走查 + TUI 活体确认瘦身后可用）。

---

## 1.3.4 —— 打磨 + TUI 退役评估（已完成）

对齐 master 立项时的五版路线表：**1.3.4 = 打磨（侧栏、主题、体验细节）+ TUI 退役评估（覆盖核心场景后）**。实际节奏已压缩——主题/侧栏多线提前在 1.3.2/1.3.3 做掉，故本版打磨只收剩余项；GUI 三块核心（会话+决策+历史）已齐，TUI 退役评估条件成立。**用户拍板：开始 1.3.4**——评估出清单与方案；**后续版本拍板（2026-08-25）：补 GUI 4 项 → 1.3.5；砍 8 项 → 1.3.5；TUI 退役执行 → 1.3.9**。

- [x] **TUI 退役评估**（主线）：①覆盖度盘点——TUI 能力清单 vs GUI 逐条对照（会话/gate/环境/steering/越界问询/决策/tasks/设置/历史/attach/队列/中断/导出）；②缺口清单——GUI 未覆盖项逐条定去留（补进 GUI 或砍）；③退役方案——范围（交互式 TUI 停运、`zhishi` CLI 命令保留）、执行时点、CI/打包/文档/README 影响清单。产出：`docs/design/1.3.4-tui-retirement.md` 评估报告。
- [x] **打磨：体验细节剩余项**：①主题切换时 xterm 终端色不热更新（1.3.3 记录）；②历史面板加载态/空态（无会话时）与载回续跑 busy 冲突提示；③空态/加载态/错误态在历史面板/attach/设置页的统一口径；④@ 补全大目录性能（缓存失效/输入防抖）。

> 实际落地（2026-08-25）：评估报告 273 行全证据——15 类能力拆 37 项对照：已覆盖 20（GUI 超集 5）、口径差异 8、未覆盖 8（4 功能缺口 + 4 终端形态专属）；去留清单（补 GUI 4：输入历史落盘+模糊评分 轻 / export sanitize 轻 / 设置页 MCP 管理 中 / 本机发现选中即注册 轻可选；砍 8：宿主终端挂起、--env 直通、token 计数、Esc 草稿槽、bracketed paste/kitty、/env、/quit、Ctrl+L 帮助面板）；退役方案含 18 条影响清单与 7 项风险（最大风险：发行版三入口「点图标/托盘/二次实例 → 弹 TUI 终端」须与退役同批切 GUI 窗口聚焦）；论证 `zhishi` CLI 子命令与 `zhishi term` 链路（panel_api）与 TUI 渲染层零耦合、独立存活。打磨四项：xterm 主题热更新（theme 订阅重染 + 修首挂载读旧变量真 bug——applyThemeClass 模块级先跑）+ HistoryPanel 三态（error/loading/empty，修「载入失败伪装暂无会话」死 bug + 刷新可达）+ 载回续跑 busy 前置闸（Esc 链口径）+ StateHint 统一状态组件（HistoryPanel/AttachView/SettingsPage 五处空态）+ @ 补全 200ms 防抖与目录缓存按环境失效（代次语义保持）。新增 4 单测；全量 183 文件 2307 测试绿 + typecheck + eslint + build:gui 绿。GUI 打磨实机走查由用户确认（无异常报告）。

> 后续版本拍板（2026-08-25）：**1.3.5 = GUI 补 4 项 + TUI 砍 8 项瘦身**；**1.3.9 = TUI 退役执行**（含三入口切换/打包/文档/README 改写）。
> 不做（维持）：编译发版（GUI 完成前，发版版含打包收口 + pty-runtime 接入 + WS upgrade 转发验证）、TUI 新功能（冻结）、B 形态引擎并行（用户已砍）、/bg 转后台（单独立版）。
> 验收：全量测试 + 实机走查。

---

## 1.3.3 —— 立项：历史面板 + 会话管理进阶（已完成）

GUI 主线收尾段：1.3.2 决策面板落定后，GUI 愿景核心块只剩「历史」一块未做——**会话 + 决策 + 历史**齐了，GUI 才算覆盖核心场景（届时可议 TUI 退役 + 编译发版）。**用户拍板：根据 roadmap 全量推进**——历史面板（主线）+ 侧栏多线进阶 + @ 补全扩展 + attach 交互式 pty；/bg 转后台单独立版。

- [x] **历史面板**（核心，本版主线候选）：会话清单（按环境/时间分组）→ 点开只读回看完整 transcript（复用 chat:stream 的 cold-history replay 基建，不抢活跃流的线）→ 从历史载回旧会话续跑（rewind/fork 端点已有，接真）。目标：研究员的「翻旧账」入口——poc/结论/决策块都在里面可检索、可续、可回溯。
- [x] **侧栏多线进阶（会话管理）**：1.3.2 A 形态只有切换没有管理——重命名/置顶/归档/删除会话。轻，UI 为主。
- [x] **attach 交互式 pty**：1.3.2 遗留——attach 页现为 environment/exec 一次性执行；升级真终端需服务端补 pty 端点（TUI 的 term 通道在 Rust panel_api 且只服务 zhishi term，成本中）。
- [x] **@ 补全扩展**：@ 提及补全（文件/子代理/工具/环境）。轻。
- [ ] **/bg 转后台**：1.3.2 留后续——turn 生命周期脱离（busy/queue/steering 三线重组），服务端大缺口，重，**单独立版，不塞本版**。

> 实际落地（2026-08-25）：历史面板全链路——GET /sessions 补 envKey（env-sessions 分线映射反查，additive）+ PATCH 补 pinned/archived（只持久化 true、不 bump lastActiveAt）+ 新增 wire 格式回看端点（`/api/loop-session/messages?format=wire`，2000 条护栏，决策块 kind:'decision' 全字段还原，纯函数 buildLoopWireMessages 与 chat-engine 委托同口径）；GUI HistoryPanel（分组/搜索/置顶优先/归档折叠组 + 只读查看器走现有 reducer replay 不扰活跃流 + 「载回续跑」POST /sessions/switch 接真）+ 会话管理动作（重命名/置顶/归档/删除二次确认，server 先行成功才更新本地——沿现有 store 惯例）。@ 补全四源分节（环境/文件/子代理/工具；`@dir/` 触发 workspace/files 目录补全，depth 上限 6、条目 1000、symlink 不跟随、agentDir 校验）。attach 真终端——服务端 WS `/api/admin/environment/term?env=`（ws + @lydell/node-pty napi prebuilds，惰性加载 + pty-runtime 回落、esbuild external node-pty/bufferutil/utf-8-validate、ws 本体 bundle）+ `docker exec -it`/`ssh -tt` 分派（bash 回退链/windows cmd；guest 断网 VM 明确拒绝无 TTY）+ 生命周期（同 env 抢占 4001+旧 pty 即杀、WS close 回收、resize 护栏）；GUI xterm.js 终端模式 + 一次性执行双模式保留。**实机走查抓出真 bug**：buildPtySshArgv/buildPtyDockerExecArgv 沿单次执行路径「argv 首元素=程序名」惯例，与 node-pty spawn(file,args) 契约冲突 → 实际跑成 `ssh ssh -tt` → ssh 解析主机名失败 exit 255；已修（args 不含程序名）+ 单测契约锁定。新增 72 单测（服务端 38 + GUI 34）；全量 183 文件 2303 测试绿 + typecheck + eslint 零错 + build:gui/build:server 绿；实机走查通过（用户确认，attach 终端在 pwn-vm ssh 通道活体）。已知取舍：Tauri 生产路径的 WS upgrade 转发未验证（GUI 完成前不编译，发版前验；不通则终端模式降级一次性执行）；wire 无 thinking 段（与 live replay 同源取舍）；node-pty 打包侧 pty-runtime 未接（发版前接）。

> 后置里程碑（不在本版）：GUI 覆盖会话+决策+历史后，议 TUI 退役 + 编译发版。
> 不做（维持）：编译发版（GUI 完成前）、TUI 新功能（冻结）、B 形态引擎并行（用户已砍）。
> 验收：全量测试 + 实机走查。

---

## 1.3.2 —— 决策面板 + 服务端缺口收口（已完成）

GUI 会话视图的地基已齐（1.3.0 骨架/1.3.1 全池）。**用户拍板：按 roadmap 全量推进**——决策面板四件 + 服务端缺口五条 + 打磨候选三件（侧栏多线/主题/attach 接真；/bg 转后台为服务端大缺口，roadmap 标注留后续）。

- [x] **决策面板**（GUI 愿景的核心块，原 1.3.3 内容提前）：①分歧提请——模型在两个方向选不出来时主动提请人决策（服务端半：教模型何时提请 + 提请前先查 expert_search，有基准不问人）；②决策卡带**专家依据区**（expert_search 命中亮出 title/criteria + E#N，未命中标注「库中无基准」）；③输入为主通道（a/b 快捷键为辅）；④拍过的板落成会话里的**决策块**（可追溯 + promote 入口）。
- [x] **服务端缺口收口**（1.3.1 记录在案的 5 条）：①boundary-ask payload 补工具名/说明/选项字段（设计稿 §6.6 契约）+ respond 落盘 note；②环境锚恢复直接进 chat:init（免 environment/current 绕行）；③intel 配置部分更新端点；④skill import 路由可达性；⑤task/list 结论字段。
- [x] **打磨候选**（可选）：侧栏多线切换（一屏多线 A 形态）、主题（深浅色切换）、attach 页接真（environment/exec 一次性执行）。
- [ ] /bg 转后台：服务端大缺口，留后续。

> 实际落地（2026-08-25）：决策面板全链路——服务端 `request_decision` loop 工具（提请前先查 expert_search 出依据区：命中=摘要行+E#N 引用、未命中/库不可用统一标注「库中无基准」；pending 内存表无超时重启即失效）+ `chat:decision-request` 广播 + `POST /chat/decision/respond`（unknown 404/resolved 409 幂等）+ 决定经 steering/直发通道注入回 loop（B3/B5/B6 线语义全守；跨线走 invokePiSession headless 注入）+ 决策块 wire `kind:'decision'`（additive，jsonl marker 持久化，replay 可还原）+ 内核 prompt 决策点教学段（分歧/无把握且库无基准才提请，先查 expert_search 命中可验证不问人）。GUI：琥珀决策卡（专家依据区 E#N 徽章/库中无基准特殊样式 + 输入主通道 + a/b 键 + Esc 收起待答 chip 重开 + 重连去重重放）+ 决策块渲染 + 悬停「入专家库」promote（expert/add 预填，domain/kind/reviewer 由用户补）。缺口五条：①boundary-ask 补 toolName/toolDescription/options + respond note 落盘 transcript（未绑定会话不造孤儿 jsonl）；②环境锚进 chat:init（GUI 免 environment/current 绕行，旧路径兜底保留）；③intel/config-update 部分更新（锁内读改写回写 config，非法值拒绝）；④skill import 可达性验证（同主 handler 链 + ACAO 放行，GUI 已在用——仅修过期注释）；⑤task/list conclusion（内存表，cron 双通道登记，重启失效但全文仍在 transcript）。新增 58 单测（服务端 32 + GUI 38）；全量 176 文件 2232 测试绿 + typecheck + eslint 零错 + build:gui 绿；实机走查通过（用户确认：主题/侧栏多线/attach/情报部分更新/决策面板活体全过）。已知取舍：attach 交互式 pty 需服务端补端点（留后续）；promote 用 expert/add（决策块无 sourceEventId 锚点，promoted 端点不可用）。

> 不做（维持）：编译发版（GUI 完成前）、TUI 退役（GUI 覆盖核心场景后）。
> 验收：全量测试 + 实机走查。

---

## 1.3.1 —— GUI 会话视图迭代（已完成）

1.3.0 已提前完成骨架 + 会话 MVP（路线压缩：原 1.3.1 骨架内容并入 1.3.0）。本版 = 会话视图的**迭代完善**：补齐 MVP 明确留下的占位、修实机缺陷、把「能用」推到「好用」。**用户拍板：按主 roadmap 全池推进，不再逐项评估**。

实施范围（全池）：
- [x] **环境准入闸**（实机缺陷，用户原则性要求）：已停止环境不可进入——侧栏点已停止环境拦截 + 提示先启动（启动按钮接 docker/VM up）；host 会话（未锚定）与锚定会话区分显性化。
- [x] **boundary-ask 模态**：越界问询（MVP 未消费 chat:boundary-ask）——GUI 原生模态，y/n + 自然语言应答。
- [x] **子代理/后台事件消费**：bg-started/finished、subagent-* 事件 → 状态栏段 + 回报卡；/tasks 面板（列表/详情/transcript）。
- [x] **/ 命令组补齐**：snapshot/rollback/extract/rewind/fork/queue/tasks/export 从占位 toast 接真接口。
- [x] **新建环境向导接真**：boot 进度从 mock 改 environment/build 真接口；attach 页接真。
- [x] **设置页**（v19 已画）：模型/skills/intel/专家知识/研究记录——1.3.0 未做，本版或后续。
- [x] **状态栏信息**：队列深度、上下文百分比、后台任务段（MVP 只留了 env/phase/模型）。

> 实际落地（2026-08-25）：七项全池交付——①环境准入闸（已停止拦截+启动按钮 environment/up+host 显性化）；②boundary-ask 模态（kind 文案本地映射+objects 清单+y/n+自然语言应答+Esc 入链）；③子代理/后台事件消费+/tasks 面板（三源合一+transcript）；④/ 命令组接真（snapshot/rollback/extract/rewind/fork/queue/tasks/export 逐条核实 zhishi.ts）；⑤新建向导接真（environment/up+ps 轮询阶段）；⑥设置页五签接真（模型/skills/情报/专家知识含导入审定/研究记录）；⑦状态栏信息。实机走查通过（用户确认）。走查修复：selectTaskRows 稳定引用（getSnapshot 契约，无限渲染黑屏）+ ErrorBoundary 上屏兜底转正式。新增 57 单测；全量 169 文件 2165 测试绿 + tsc + eslint + build:gui 绿。服务端缺口清单（5 条，记录在案未改 server）：boundary-ask payload 无工具名/说明字段、环境锚恢复需绕行 environment/current、intel 配置无部分更新端点、skill import 路由标注 Tauri-only 未验、task/list 无结论字段。

> 不做（维持）：决策面板（后续版本，用户拍板延后）、主题、侧栏多线管理进阶、编译发版（GUI 完成前）。
> 验收：全量测试 + 实机走查。

---

## 1.3.0 —— GUI 会话视图 MVP（已完成）

方向重大调整（用户拍板 2026-08-24）：**TUI 渲染层止损，转 GUI**。顺序：**GUI 先做 MVP → 迭代 → 覆盖核心场景后退役 TUI**。原型已定稿（`docs/spec/gui-prototype-v19.html`，全功能交互版，开发参照），用户拍板**直接开始开发**——实现须按我们自己的理解修正原型缺口。

**技术栈定稿（用户拍板）**：React 18 + Vite + Tailwind + zustand + @tanstack/react-virtual，纯 TS；前端代码在 `src/gui/`；Vite build 产物进 resources 随包分发（与 CLI 同径）；Tauri 开窗（现壳无窗口）+ webview 直连 sidecar SSE（fetch+ReadableStream，照 `src/cli/tui/client.ts` 契约，不改服务端）。

- [x] **GUI 骨架 + 会话 MVP（本版交付）**：①Tauri 开窗 + sidecar 生命周期联动（端口注入沿用 sidecar.port/ZHISHI_PORT）；②前端脚手架 + SSE 客户端 + 会话流渲染；③环境侧栏（三组：运行中/已停止/本机已有，切换即换流）+ 新建向导骨架 + attach 占位；④块化流（输入=块首、结论聚合亮顶、thought/工具卡折叠、抽屉详情）；⑤输入区（/ @ 补全、Ctrl+R 历史、**steering：运行中输入即纠偏**）；⑥状态栏（env/phase/模型切换）；⑦Esc 链（一次弹一层：overlay→模态→attach→设置，busy 且无面板才中断；drawer 入链）。
- [ ] **TUI 冻结**：不投功能/视觉，只修致命 bug。
- [x] **验收**：全量测试（前端单测 vitest）+ 实机走查（开窗/会话流/发送/纠偏/切环境/模型切换）。打包安装验证不在本版——GUI 完成前不编译（用户拍板），挪到发版前。

> 原型缺口修正清单（开发必须带上）：①steering 输入即纠偏（v19 缺——busy 态 Enter 被吞）；②块容器+结论聚合亮顶（v19 只做了工具卡折叠）；③Esc 链优先级（v19 双处理器叠加）+ drawer 入链；④切环境换流（v19 未体现「每环境独立历史」）。
> 实机发现缺陷（1.3.0 记录，后续修）：环境准入闸——已停止环境不应可进入（当前引擎语义允许选已停环境、env_exec 才失败；GUI 侧栏点已停止环境应拦截并提示先启动，启动按钮接 docker/VM up 接口）；host 会话（未锚定环境）与锚定会话的区分要更显性。
> 明确不做（本版）：决策面板（后续迭代）、设置页（1.3.3，v19 已画，不进 MVP）、侧栏多线管理进阶、主题（1.3.4）、编译发版（GUI 完成前）。
> 后续迭代：决策面板（越界+分歧提请+专家依据）、历史面板、@ 补全扩展、侧栏、主题；GUI 覆盖会话+决策+历史后退役 TUI。
> 技术面：窗口/IPC/sidecar 联动（Rust 侧）、SSE 直连（已验证决策）、块数据语义（前端聚合，后端暂不改）、多环境分层（A 一屏多线=界面层随 GUI 迭代；B 多线真并行=引擎层单独立版）。

---

## 1.2.10 —— zhishi 命令入 PATH + 专家知识导入（已完成）

缘起：用户想在 TUI 中方便地用 zhishi 命令，并指出根子是**安装后 zhishi 不在环境变量里**——PATH 通了，TUI/终端里用 zhishi 都顺势解决；另专家知识「新建」目前只有编辑器往返（edit），需要支持导入 JSON/YAML 现成文件。

- [ ] **安装后 zhishi 入 PATH**：NSIS POSTINSTALL 落 `<数据目录>\bin` 的 CLI 三件套（zhishi/zhishi.cmd/package.json，cmd 烘焙 bundled node 绝对路径——不依赖用户自己装 node）+ 用户 PATH 注册（HKCU Environment + WM_SETTINGCHANGE 广播，去重）；POSTUNINSTALL 移除 PATH 项；launcher 镜像侧同口径（zhishi.cmd 改为生成式烘焙 node 路径，两处产物一致不 churn）。便携/USB 模式不动（不写 PATH）。
- [ ] **`zhishi expert import <file>`**：JSON/YAML 自动识别（js-yaml 已是依赖），单对象/数组批量，逐条 validateEntry + 复用 expert/add 路由（服务端零改动），逐条报错不阻塞（seed 先例），provenance=user、reviewer 取文件字段或 --reviewer 兜底；help + user-guide 写格式。
- [x] **安装后 zhishi 入 PATH**：NSIS POSTINSTALL 落 `<数据目录>\bin` 的 CLI 三件套（zhishi/zhishi.cmd/package.json，cmd 烘焙 bundled node 绝对路径——不依赖用户自己装 node）+ 用户 PATH 注册（HKCU Environment + WM_SETTINGCHANGE 广播，去重）；POSTUNINSTALL 移除 PATH 项；launcher 镜像侧同口径（zhishi.cmd 改为生成式烘焙 node 路径，两处产物一致不 churn）。便携/USB 模式不动（不写 PATH）。
- [x] **`zhishi expert import <file>`**：JSON/YAML 自动识别（js-yaml 已是依赖），单对象/数组批量，逐条 validateEntry + 复用 expert/add 路由（服务端零改动），逐条报错不阻塞（seed 先例），provenance=user、reviewer 取文件字段或 --reviewer 兜底；help + user-guide 写格式。
- [x] **验收**：全量测试 + 实机安装验证（装完开新终端 `zhishi --version` 可用）+ import 活体（yaml/json 各一）。

> 实际落地（2026-08-23）：两项全落。安装侧三个坑实机抓出并修掉：①Tauri NSIS 资源在 Windows 落安装根目录而非 resources\ 子目录（首版 ps1 路径错误静默不执行）；②PowerShell 数组字面量里未加括号的拼接表达式会被拆成多元素（生成的 cmd 路径断行）；③**PS1 含中文注释必须带 UTF-8 BOM**（无 BOM 被 PS5.1 按 GBK 误读，注释行吞掉下一行的 Copy-Item——zhishi.js 不落盘）。终装全链路验证：清场 → 静默安装 → bin 三件套齐 + cmd 烘焙正确 + HKCU PATH 注册 + `zhishi --version` 可跑；卸载脚本 standalone 验证（只删目标条目、旁支保留）。expert import 活体：yaml 批量一好一坏（坏的按缺 reviewer 拒绝）、json 单条入库、search 可查、清理完毕。全量 156 文件 2039 测试绿 + typecheck + eslint 零错。

> 明确不做：TUI 的 expert 面板、其余 CLI 命令的逐个斜杠化、TUI /cli 透传（用户拍板：PATH 通了就不需要）。
> 决策记录（2026-08-23 用户）：TUI /cli 透传不做——zhishi 入 PATH 后，用命令直接开终端敲即可，TUI 内不再加透传通道。
- [ ] **验收**：全量测试 + 实机安装验证（装完开新终端 `zhishi --version` 可用）+ import 活体（yaml/json 各一）。

> 明确不做：TUI 的 expert 面板、其余 CLI 命令的逐个斜杠化。

---

## 1.2.9 —— TUI 的 BUG 检查·续（已完成）

方向延续「做深不做广」。主题：TUI bug 续修——1.2.8 普查之外的实机反馈驱动。用户实机报告四条：①模型供应商面板全部显示「未配 key」，但对话实际可用（kimi key 已配）——显示与真实配置脱节，且用户无法判断当前在用哪个模型；②斜杠命令交互弱——`/model` 之后没有下一步引导，用户不知道能干什么；③Tab 无法补全；④无 ↑/↓ 历史对话快速召回。

- [x] **摸底定性**：四条逐条定位（供应商面板的 key 状态读取链路、/model 命令的交互闭环、Tab 键路由、↑/↓ 历史召回接线），区分真 bug / 没接线 / 设计缺口。
- [x] **按证据修复**：带回归测试。
- [x] **验收**：全量测试 + TUI 活体。

> 实际落地（2026-08-23）：定性——①**真 bug**（双 id 口径：显示链路精确查 `providerApiKeys['kimi']`，运行链路对 kimi 系模糊匹配；用户配的 `moonshot-coding` 能跑但显示未配）；②**设计缺口**（/model 状态卡纯展示无引导）；③④**当前源码实测均正常**（完整字节链路驱动验证通过），实机失败主因是旧包 + 预期差。修复：Q1 kimi 内置条目 key 判定对齐运行链路口径（id 含 kimi/moonshot 且非 openai 协议定义）+ model/list 新增 current 字段（当前使用 provider · model，与 resolveLoopModel 同回落规则）；Q2 状态卡表头显示「当前使用」+ 末尾「下一步」引导行；Q3 Tab 在输入以 / 或 @ 开头时主动唤起补全面板（原 completion 分支是不可达死代码，删除）；Q4 补 app 级字节链路回归测试（↑ 召回/再 ↑ 更老/↓ 返回）。新增 9 测试（admin-model-list 6 + model 卡 2 + app 级 3 中部分计）；全量 155 文件 2017 测试绿 + typecheck + eslint 零错；活体 model/list 核验：kimi 已配 key=True、current={moonshot-coding · k3}、moonshot preset 不误标。

> 明确不做：TUI 新功能、视觉调整。

---

## 1.2.8 —— TUI 的 BUG 检查（已完成）

方向延续「做深不做广」。主题：TUI（v2，~7.6K 行）的 bug 普查——不优化、不重构，只找 bug 修 bug。

- [x] **摸底审查**：事件链路（SSE → event-reducer → 渲染）逐环节过；状态机（busy/队列/steering/中断）边角；渲染层（frame-scheduler/terminal-writer/blocks）错绘漏绘；gate/会话续接/环境切换路径；已知疑点复核。产出：TUI bug 台账（带证据与复现路径）。
- [x] **按证据修复**：确认是 bug 的逐个修（带回归测试）；疑似的先复现再定性。
- [x] **验收**：全量测试 + TUI 活体（真 sidecar 跑交互会话）。

> 实际落地（2026-08-23）：三路普查（事件链路/渲染层/交互状态机）出 34 条台账 → 对照设计文档与各版 roadmap 逐条定性：**24 真 bug、2 业务特性**（L8 回看视口漂移=注释明示取舍、L9 gate Ctrl+C=文档口径一致）、其余低危记录。按族修复 24 项：①事件契约（补 thinking-end→chat:thinking-complete 治思考串台、tool-result 透传 isError 治失败永显成功、queue:added 消费 isInFlight 治队列幻影）；②重连/重进（/env 重进泵叠加、live 块重连去重+reset 全量重绘、服务端重连补发队列快照、rewind 清全量 seenSrvIds）；③attach/崩溃（挂起 stdin 暂停+SIGINT 屏蔽、挂起 resize 清屏守卫、uncaughtException/exit 终端恢复兜底）；④gate（modal 键路由优先、盘点代际锁、gate 模式 ingest 不写屏）；⑤渲染（折行光标 off-by-one+多 chunk 覆写、小终端保尾截断、resize 重夹高度+chrome 重组、CJK 显示格对齐/截断口径统一）；⑥输入（sse-parser 单空格规范、背压 message-chunk 合并不替换、paste 跨 chunk 缓冲、stdin utf8、多行历史 split、多行斜杠守卫）；⑦杂项（steering 双提示、stop 幻影分隔条、状态栏滤 done）。新增 60+ 回归测试；全量 153 文件 2006 测试绿 + typecheck + eslint 零错；m4a/m4b 活体全过（thinking-complete 线上可见、env_exec 上 VM 返回 fuzz 主机名、isError 字段在线）。业务特性 2 条与低危遗留（L6 分帧 CSI、L8/L9 等）记录在案。

> 明确不做：TUI 新功能、交互优化、视觉调整。

---

## 1.2.7 —— 上下文管理与压缩（已完成）

方向延续「做深不做广」。主题：上下文管理——系统提示与会话历史的全生命周期（增长、预算、压缩、存活）。**先摸清现状，再深度探讨**（用户定调）。设计稿：`docs/design/1.2.7-design.md`。拍板：切分按研究阶段；域判定 = 配方默认 + 内容信号动态修正；窗口口径按 preset 声明值（deepseek 1M）；一版全量做完。

- [x] **现状摸底**：系统提示逐段实测（组装开销、token 占比、各段增长曲线）；会话历史增长模型（消息/工具结果怎么膨胀）；压缩机制实测（触发点、存活契约、裁完后的上下文质量）；长会话的真实瓶颈在哪。产出：上下文管理现状报告（带实测数据）。
- [x] **深度探讨对齐**：按现状报告定优化方向。
- [x] **实施 + 验收**。

> 实际落地（2026-08-20）：摸底实证——系统提示 ≈14.4K 字符（skills 段独占 ~11K/77%，全量无域注入）；压缩三缺陷确认（keep 集命中率 ~52% 致第一档空转、usage 锚定使裁后重估失真、存活契约漏中文突破/exit=0 约束事实/fuzz 崩溃信号）；pi agentLoop 无内建溢出重试（isContextOverflow 仅检测工具）。落地四件：①**窗口口径接线**——resolveLoopModel/FromEnv 经 lookupModelContextLength 取注册表真实窗口（deepseek 1M 生效，未知模型才落 200K）；②**实时上下文管理**——新建 context-manager.ts：按研究阶段切分（anchor/侦察/分析/构造/执行/评估，无信号继承上段相位）→ 标注 → 采样锚定（必保 anchor ∪ 当前阶段 ∪ key 段，历史段从最老起逐个 stub 化到达标即停）→ 注意力布局（头 anchor 原文/中矮 stub 索引/尾当前阶段原文，stub 含命中行原文摘录 + 工具名录 + 存档指针）；compaction 重写为段级压缩，裁后重估改纯字符口径（修 usage 锚失真），存活契约扩中文族/exit=0 约束族/fuzz 崩溃族；③**域边界**——resolveSessionDomain 动态修正（最近 20 条消息信号计数，强信号 ≥2 且严格领先才改判，基线≠信号域需 ≥3 且 2 倍），skills 按域注入（通用 skills 保留、清单缺目录容错、无域全量），capabilities 段按域收窄（无域逐字节一致）；④**溢出兜底**——isContextOverflow 命中（stopReason=error）→ thresholdRatio=0 强制压缩重试，每 turn 限 1 次（交互 turn 与 cron invoke 通道同语义；溢出 attempt 的错误条/message-complete 不上屏、不进 jsonl）。红线保持：jsonl 全量不动、transform 只投影不污染 transcript、tool 配对闭包、无域降级全量。域补丁（同日）：subagent 继承会话域——`filterAgentsByDomain` 按 domain.json subagents 收窄可派发清单（与 skills 过滤同语义），同一 turn 内域判定一次算出、系统提示与执行栈共用（交互 + cron invoke 双通道）。**场景实测**（用户指定六场景 + 极端场景 + kimi-for-coding 活体，设计稿 §九有全量数据）抓出并修复四个真缺陷：①段内子段切分（单任务长会话巨型段无可 stub）+ 当前阶段全保收窄到最近 8 段（整会话同相位时必保集=全集的空转）；②中文估算低估 2.3 倍撞 400 → CJK 校准估算器（含 usage 锚尾部口径）；③CWE 入存活契约（白盒事实锚）；④强制重试预算 0→0.25（压成残渣漏引事实）。活体终版：442K 估算触发 → 实报 73.7K/262K 一次成功无 400，跨域四个关键事实全部被模型带段号引用。新增 70+ 单测（含可重复场景套件）；全量 1960 测试 + typecheck + eslint 绿。遗留记录：subagent 子 loop 未接溢出重试（压缩已有）；域切换有 20 条消息窗口的迟滞（防翻转设计）；key 段崩溃签名去重为后续候选。

> 明确不做：新功能。

---

## 1.2.6 —— 引擎深化：修 bug + 上下文提质（已完成）

方向延续「做深不做广」。主题：harness 引擎本体——不修优化之名，行修复 bug + 提供更好的上下文之实（用户定调）。**先摸清引擎现状，再按证据动手**。

- [x] **引擎摸底**：①bug 清单——已知残留问题逐个核实（cron 共用引擎单例的语义残留、switchPiSession 强停 vs 拒绝的分叉、队列/中断/回看边角）+ 引擎层代码审查新发现；②上下文质量审查——每 turn 组装的系统提示各段（内核/能力清单/域信号/研究记忆/专家知识/情报提示）的实际形态、预算分配、时效、相互挤压情况。产出：引擎 bug 台账 + 上下文质量报告。
- [x] **按证据修复**：bug 逐个修（带回归测试）；上下文各段按提质判据修（该清楚的清楚、该新鲜的新鲜、该闭嘴的闭嘴）。
- [x] **验收**：引擎层全链路活体回归（smoke 5/5 + 真实任务 dogfood）。

> 实际落地（2026-08-22）：摸底实证 13 个 bug 全部修复——cron 链路（B1 new_session 必 500→开线绑定；B2 单例三切面→独立 invoke 通道；B9 退出机制教学断链→对齐 [CRON_TASK_COMPLETE] 真实机制并接线；B10 回报僵尸 sessionId→全路径写 setActiveSessionId）、数据完整性（B3 turn 串线→起跑快照 sessionId；B4 双 turn→force 塞回队首；B5 steering 孤儿→drain 队首 + send-and-wait 按 queueId 归属；B6 steering 幽灵消息→注入补 wire 保 rewind 序数）、能力（B8 子 loop 接 abort + 挂压缩）、上下文清扫包（陈旧 SDK/Bash 文案、CLI 幻觉源归人侧、cliToolsEnabled 接线、能力清单截断环境条目保最后、skills 用户库最后丢、research-log 段余量修复）+ compaction 边界（error 误伤收窄、占位契约对齐、系统提示入阈值估算、裁完第二档升级路径）。全量 1895 测试绿（新增 48 例）+ smoke 5/5 + cron execute-sync new_session 路径活体验证（返回真 sessionId）。B7/B11/B13 低优先尾项记录在案未修。

> 明确不做：新功能、新工具、新域。

---

## 1.2.5 —— 原生工具选型与链路深化（已完成）

方向延续「做深不做广」。主题：每个研究域的专属工具——工具市场杂乱，要做选型：什么样的工具配合得好大模型、大模型用什么工具最适合；工具的部署、落地、完整链路；工具有解决不了的问题时如何处置。**先摸清当前实现，再深度思考**（用户定调）。

- [x] **现状摸底**：各域工具清单（bundled-environments 配方实际装了什么、skills 声明了什么、agent 实际用了什么——三方对齐度）、部署链路（配方 Dockerfile → 环境内安装 → 工具自检 toolCheck → `zhishi domain check`）、调用链路（发现 → 描述 → 调用 → 教会 → 反馈的现状）。产出：逐域工具台账 + 链路现状图。
- [x] **选型方法论**：什么样的工具配合得好大模型（输出结构、错误可读性、非交互性、可脚本化、结果可机器判读）vs 什么样的不适合；选型判据成型。
- [x] **部署落地链路深化**：配方 → 安装 → 自检 → 调用 → 留痕的完整链路体检与加固。
- [x] **问题处置机制**：工具有解决不了的问题（装不上/跑不动/输出不可判读/版本漂移）时的标准处置路径。

> 实际落地（2026-08-22）：选——两轮六域网络调研（认证课程+发行版预装+从业者榜单+GitHub 实时活跃度交叉验证，「先调研不猜」救了一个错误处置：garak 原拟删，调研翻案为留+教）+ 用户四条修正（浏览器/JS+API 分析/协议+文件格式分析/rev 并入 binary），选型终稿 v2 落档 `docs/design/1.2.5-analysis.md`。组——六域配方按终稿改 + pentest-vm 新配方 + rev 并入 binary 域 + ENVIRONMENT_RECIPES_VERSION→6。配——toolCheck 词汇映射（声明词→真实探测命令）+ VM 挂点（快照前自检，缺工具不冻结模板）+ 配方播种改内容哈希同步（旧版备份可回滚）+ domain check 覆盖 VM。用——配方工作流摘要进能力清单（段顶抬 4000，两层预算核心清单永不丢）+ skills 友好用法固化 + garak 信号规则按真实 JSONL 实证。全量 1847 测试绿 + smoke 5/5。Dockerfile 网络型安装段未经 docker build 实机验证（本机无 docker），已标注。

> 明确不做：新工具的大规模扩充（选型先行，扩充有据后再说）、新功能。

---

## 1.2.4 —— 蒸馏弧深化（已完成）

方向切换（用户拍板 2026-08-22）：1.2.4 起**做深不做广**，不迭代新功能，做到能用、能打。首选最深的点：蒸馏弧（harness 三件内建之一，「让循环越转越好」）——管道通了但反喂质量没人管过。目的=增强；链路审查是找出深化点的侦察手段，不是验收审判。

- [x] **链路审查**（为深化找点）：research_events → 蒸馏弧 → 蒸馏经验 → 逐 turn 反喂系统提示——读清每个环节实际在做什么、反喂进 prompt 的实际内容是什么形态/质量/占比。
- [x] **反喂内容深化**：蒸馏产物抬到「操作级知识」标准（哪个工具组合有效 / 哪条是死路 / 什么信号往哪走），蒸馏 prompt 与注入点按此改；时效与置信度分级在反喂时的应用（旧经验还喂不喂、可疑经验喂不喂、死路教训防过度回避）。
- [x] **真实负载深化**：CVE 复现（D21 欠账）当主载体——完整复现一个 CVE，真实轨迹进蒸馏弧，下一轮同类任务检验反喂效果（回合数/重复踩坑是调参仪表，不是目的）。

> 实际落地（2026-08-22）：审查实证七个深化点全部落地——①注入预算倒挂修复（实证 bug：蒸馏 6000 vs 注入 2000，第三节尾部被静默砍 → 单一预算源 + 截断可观测）②expert_refs 进蒸馏 prompt（追溯环闭上）③fail/stuck 事件轨迹深摘（根因级原料，路径穿越闸）④注入按当前会话域过滤（现场选择→配方绑定→domain.json 反查）+ judge 判错降权 ⑤时效/来源/环境锚点进蒸馏契约 ⑥重复事件=置信加强指令 ⑦话题弧标注「给人看的档案」定位。CVE 复现 dogfood（D21 欠账还清）：CVE-2024-23334（aiohttp 目录穿越）完整复现——intel 选型（按环境前提排除 glibc 备选）→ 镜像装漏洞版 → 默认配置打不出时不硬凑、拉官方源码 diff 定位修复点（follow_symlinks 分支）→ 改配置复现 → /etc/passwd 全文泄露实证 + 3.9.2 修复版对照 404 → 留痕 0.95 + PoC 挂 trajectory_ref + 修复前后对照证据。全量 1818 测试绿（新增 25 例）+ smoke 5/5。

> 明确不做：新功能、新域、发行链路、度量期（等真实使用数据）。

---

## 1.2.3 —— 构建产物修复与验证（已完成）

主题：修复 issue #5 + 建立「构建产物」验证链路——此前所有验证（npm test / smoke）都跑在 tsx 源码上，打包产物（用户真正运行的形态）从未被验过。分析记录见 `docs/design/1.2.3-design.md`。

- [x] **修复 #5：CLI bundle cjs 导致 import.meta fallback 日志污染 TUI**——双管齐下：CLI bundle 改 esm（import.meta 恢复，路径与日志一起消失）+ 切断 CLI→server 依赖（RESEARCH_TASK_KINDS/validate/app-dirs/sse-parser/manifest 挪 shared，CLI bundle 里 server 文件 7→0）。
- [x] **构建链路审查**：五项腐化清理——macOS novo 必挂检查（不修则 macOS 构建一直挂）、NSIS novo 死宏、tauri.conf 死引用、windows analytics 死逻辑（117 行）、文档作废项。附带发现两条断链（`~/.zhishi/bin/zhishi` 安装者缺失、macOS SDK_DEST 未定义）记入设计文档，归发行链路版本。
- [x] **产物级验证**：`tmp/m123-dist-smoke.mjs`——构建零警告门槛 + 产物 sidecar 全链路 + #5 回归钉，全 PASS。教训沉淀：admin 路由在 deferred init 未完成时回 warming-up，产物验证必须等 /health/ready。

> 实际落地（2026-08-22）：全量测试绿（1793 过——差值 121 与删除的 7 个 appcraft 测试文件精确吻合）+ smoke 5/5 + 产物 smoke 全 PASS。mac/linux 脚本与 NSIS 打包未实机验证（无对应环境），已在设计文档标注。issue #5 已关闭（带修复说明）。
>
> 追加（同日，用户拍板）：**AppCraft 整体退役**（桌面自动化与安全主线无关 + 其二进制闭源不可得 + 数周失效无人在意）——模块/CLI 命令组/内置 MCP 注册/app-automation skill/vendored terminator/下载脚本全切。直接收益：**完整 NSIS 构建端到端通过**（无裁剪，setup.exe 106M + portable.zip 63M/2759 条目全资源），打包彻底解卡。已知：正式发版还需 TAURI_SIGNING_PRIVATE_KEY；~~zhishi-updater 二进制靠手动 cargo build~~ 已接入三端构建脚本（同版后段 `8efad04`，原文记录过时已更正）。

---

## 1.2.2 —— 专家知识层·飞轮期（已完成）

校准协作主线第二期：让专家知识层开始自我积累、使用留下痕迹。方案：`docs/spec/expert-knowledge-plan.md` 二期节。

- [x] **缺口识别教学打磨**（1.2.1 遗留的最核心短板）：「最后落脚点」语义已定（先尽力，识别缺口才查），本版把识别信号写具体——各域 skill 给出该域的缺口实例清单（如二进制域：cyclic 反查不出偏移、防护清单对不上已知利用路径），把抽象的「没把握」变成可对照的信号。
- [x] **引用追踪 + 冲突记录**（飞轮的仪表盘）：research_log 可关联 expert entry id（「本次决策依据 E#N」）；报告（1.2.0 出口）标注引用的专家条目；LLM 判断与专家知识冲突时记录冲突点。没有这层，度量期（等真实使用数据，原记「1.2.3」系笔误，顺延至后续版本）无数据可量。
- [x] **promote 常态化**：研究收尾（成功/卡住结案）时 agent 主动提示「这条经验值得晋升吗？」，人审入库——内容开始滚起来。
- [x] **顺带修缺陷**：system skills 在纯 sidecar 模式（无 Tauri 宿主）不随包更新——CLI-only 用户永远拿不到 skill 更新（1.2.1 实验实测发现，正确性问题）。

> 实际落地（2026-08-22）：research_events 加 `expert_refs` 列（幂等迁移照 distilled_at 先例，id 查证 expert.db）；报告加「引用的专家知识」节（factOnly 三重防线：不进填肉 prompt/不接受回填/渲染忽略叙述）；结案提示走 research_log 返回文本（success/stuck 带 `zhishi expert promote #N` 指引，fail 不带——零时序猜测）。④ 修复：Node 侧 seed 对 system skills 做内容哈希同步（与 Rust 版本门共存不打架，CLI-only/dev 不再冻结在首装版）。活体验收 9/9 PASS（检索→挂 refs 留痕→promote 提示→报告引用节→meta.expertRefs 全链）。全量 1914 测试绿（新增 25 例）+ smoke 5/5。

---

## 1.2.1 —— 专家知识层·骨架期（已完成）

校准协作主线第一期：专家知识库。定位与边界经多轮对齐（用户拍板）：专家知识 ≠ skills（方法）≠ 蒸馏弧（LLM 自身经验）≠ intel 库（结果原料）；它是权威梯度的最高级、LLM 与用户都无能为力时的**最后落脚点**。完整方案（三期迭代 + 技术细节）：`docs/spec/expert-knowledge-plan.md`。

- [x] **库与检索**：`~/.zhishi/expert.db`（独立库，FTS5）+ loop 工具 `expert_search`（无条件注册，权威呈现与 intel「线索不是结论」对照）。
- [x] **输入三通道**：agent 起草→drafts 表→`zhishi expert review` 人审（主通道）；编辑器往返（`expert new/edit`，crontab -e 模式，临时文件仅草稿介质）；`expert promote <eventId>`（蒸馏晋升，人改完保存=审定——LLM 知识变专家知识的唯一分界线）。
- [x] **格式契约**：`validateEntry()` 单点校验（kind/domain 闭集、title/applicability/content/criteria 必填、provenance 通道写入、reviewer 条件必填），三通道全汇于此。
- [x] **内置首批**：`bundled-expert/<domain>/*.md`（发行载体非存储，content_hash 幂等进库），5 条/四域，选题全部来自 dogfood 亲历卡点。
- [x] **时机教学**：内核权威语义 + 各域 skill 求助时机。
- [x] **验收**：对照实验（虚构服务 zsrv 黑盒拿 flag）。

> 实际落地（2026-08-22）：对照实验三连跑，每跑都出真发现——①基线（无库）自建功但 32 次盲扫；②有库未引导：`expert_search` 零调用——复核后认定这是**正确行为**不是缺陷：基线没有「不会」，只有「慢」，专家知识是最后落脚点不是加速器；③引导+检索修复后：1 次查询命中 → quirk 驱动 → **32→14 次调用（-56%）拿 flag**——救援链路端到端成立。实战抓修一个骨架级缺陷：FTS AND 语义对长句自然查询必空（「zsrv KV 查询服务 安全测试 漏洞利用」0 命中）——改分级放宽链（AND→OR+bm25→逐词元 LIKE），回归测试钉死。时机语义经用户纠偏定稿：**先尽力，识别到知识缺口（反复失败/没把握/无先例）才查；进展慢不是缺口**（曾误入「先查一次」，已纠正回「最后落脚点」语义）。**遗留 1.2.2**：缺口识别信号的 skills 教学打磨；system skills 在纯 sidecar 模式（无 Tauri 宿主）不随包更新的环境问题另记。全量 1895 测试绿 + smoke 5/5。

---

## 1.2.0 —— 研究交付：/export 一键出报告（已完成）

功能里程碑：把留痕设施（loop-sessions / research_events / 子代理 transcript）变现为可交付成果。TUI 单入口 `/export`（环境绑定与热连接只在会话在场时保证；CLI 不做）。组装逻辑全在 sidecar。细节与技术边见 `docs/design/1.2.0-design.md`。

- [x] **报告组装器**（server）：确定性骨架（事实钉死：事件流/证据/文件行号不许 LLM 碰）+ LLM 填肉（只写过程叙述）+ 按域模板（pentest/whitebox/二进制等骨架不同）。报告 = 目录（`output/reports/<slug>/`：report.md + evidence/）。
- [x] **证据回收链**：留痕纪律升级——research_log 挂 `trajectory_ref`（tool description + skills 双侧补「产出工件必挂路径」）→ 导出时按事件登记经 extract 通道批量回收到 evidence/；环境已下线 → 报告保留环境内路径 + 明确降级标注（transcript 内嵌证据兜底引用）。
- [x] **导出闸门**：批量一次批准（证据清单 + 落点一次列清，人批一次——不逐文件问）；敏感项清单（导出时列出 flag/密钥/IP 计数，知情在人）；默认完整导出，显式 `--sanitize` 才脱敏。
- [x] **验收**：pentest 域活体全链路 PASS（真实 SQLi→LFI 拿 flag → PoC 挂 trajectory_ref → 一次批准 → evidence/ 回收到 PoC 本体 → 报告含完整利用链）；whitebox 域 PASS（报告带 db.py:20/files.py:9/util.py:11——埋雷点全中）。

> 关键设计决策（2026-08-21 与用户敲定）：①报告=目录不是单文件（证据本体进 evidence/）；②脱敏版不是成果报告——默认完整，脱敏是显式选择；③TUI 单入口（脱离 TUI = 脱离环境）；④报告生成走独立一次性 loop，不占引擎单例会话线。
>
> 实际落地（2026-08-21）：新模块 `src/server/report/`（skeleton/templates/sensitive/narrate/evidence/export，纯函数+薄 IO 全注入）；`handleEnvironmentExtract` 的 scp argv 抽共享纯函数（原 handler 行为等价）；四域 skills + research_log description 补 trajectory_ref 纪律；TUI `/export [sanitize]`（进度/降级/脱敏插行）。全量 1820 测试绿（新增 41 例）+ typecheck/eslint/depcruise 干净 + smoke 5/5。已知限制：docker 环境证据回收走降级标注；报告叙述质量依赖填肉模型。

---

## 1.1.10 —— 子代理可审计 + app.ts 拆分（已完成）

- [x] **A′ 子代理 transcript 只读查看**（1.1.9 U1 的真落地——「完整进入子会话」已论证放弃，改只读查看，吃 90% 价值零导航语义）：服务端 delegate_task 补 `storeDir` 持久化（spawnSubLoop 半现成）+ `subagent-finished` 事件带 sessionId + loop-sessions 读取端点；TUI `/tasks` 详情页扩展为只读 transcript（每轮工具调用+输出+回复全文，可滚动）。验收：跑一个 delegate_task 子任务，/tasks 里能看到它的完整工作史。
- [x] **B app.ts 拆分**（1.1.9 留下的第一件事；照 1.1.7 手法，纯搬移不改行为）：slash 命令抽 `slash/`、overlay 收 reducer 模式（`model.ts` 的 reduceHiddenLine 是现成范式）、gate+manualForm 抽 controller；app.ts 只留路由+组装。验收：app.ts 行数大幅下降 + 全量测试绿（断言零改动）。
- [x] **C 搭车小项**：U5 工具卡多展开（drawer 可选目标，不只最新一个）；U8 状态栏 token 用量展示（usage 已收未展）。

> 方案论证（2026-08-21 与用户敲定）：「进入子代理会话」（完整切换/续跑）不做——导航语义膨胀、低频场景不值一套导航系统；只读 transcript 吃下审计证据链的核心价值。细节见 `docs/design/1.1.10-design.md`。
>
> 实际落地（2026-08-21）：A′ 服务端（storeDir 接通 + 事件带 loopSessionId + `GET /api/loop-session/messages` 端点，200 条/100KB 护栏）+ TUI（/tasks 详情 transcript 异步加载/滚动/缓存三态）；活体验收全 PASS（子代理跑 gcc 查证 → 事件带 loopSessionId → 端点读回完整工作史）。B 三刀 app.ts 1848→1258 行（slash/ 五文件 + overlay-reducer + gate-controller，四个 app 级测试零改动）。C 两项落地。全量 1779 测试绿 + typecheck/eslint/depcruise 干净 + smoke 5/5。

---

## 1.1.9 —— TUI 优化：性能基本盘 + 子代理可见性（已完成）

TUI（自研 v2）优化版。候选池全量摸底见 `docs/design/1.1.9-design.md`（每项带文件:行号证据）。本版**不做** `app.ts` 大拆分（H1）——与渲染管线改动并行会搅 diff，归下版。

- [x] **性能四件**：
  - P1 流式渲染 O(n²) → 尾部增量（每个 chunk 对累计全文重解析 markdown + 重折行；稳定前缀缓存，只重算末段）
  - P3 `Intl.Segmenter` 每次新建 → 模块级单例（一行，全链路受益）
  - P4 chrome 高度变化 → 全屏 invalidate+flush → 收窄 invalidate 范围 + flush 降级合帧
  - P5 resize 无防抖（拖窗口逐事件全量重折行）→ 走帧调度合帧
  - 验收：长回复流式尾部不掉帧（前后同任务对比帧耗时/CPU），全量 TUI 测试绿
- [x] **子代理可见性**：U1 修死按钮（完成行「要我切过去吗？(y)」按键路由无处理）+ U2 补 `/tasks` 面板（`bg-tasks.ts` 注释承诺过；列出 tasks/bgProcs、可选中看结论，复用 queue overlay 模式）。验收：按 y 切换生效；`/tasks` 列表/详情可用，窄终端不再静默丢信息
- [x] **小 UX 三件**：U3 Esc 清草稿可恢复（一次性恢复槽）；U6 回看键位接线（PgUp/PgDn 改 scrollPages 整页、补跳顶/回底键位——`scrollPages`/`scrollToTop` 已实现未绑定）；U7a 粘贴后触发补全（paste 路径补 `updateLiveCompletion`）
- [x] **卫生两件**：H2 状态栏 compose 重复两份合一处；H3 `as unknown as Block` 类型绕过改按 kind 精确工厂

> 实际落地（2026-08-21）：性能微基准（50KB markdown × 250 chunk，写屏字节逐字节相同）——帧均耗时 **52.2ms → 5.5ms**（P3 单例 −40%，P1 增量折行再 −83%；P1 正确性由 53 例 property 测试锁死：随机 chunk 切分下增量与全量折行逐 segment 深相等，含 grapheme 簇跨界修复）。U2 `/tasks` 面板落地（列表/详情两层，事件到达自动刷新）。**U1 方案变更**：核实发现「切过去」的服务端目标不存在（subagent loop 会话未持久化、无 sessionId 映射）——按预案移除误导文案、保留 switchHook 数据标记，真正的切换功能需服务端先补子会话持久化（归后续版本）。全量 1757 测试绿 + typecheck/eslint 干净；键位变化已同步 `docs/user-guide.md`。TUI 无活体驱动，真机手感（长回复流式、/tasks 面板）建议人工过一遍。

---

## 1.1.8 —— 三域 skills 实战验证（已完成）

产品深度版：pentest / whitebox / ai-security 三域 skills「声明齐、实战未验证」的欠账清零（原「未排版本」项收编）。binary 域已验证（ret2win），本版补三域。细节见 `docs/design/1.1.8-design.md`。

- [x] **whitebox 域实战**：造「埋雷代码库」夹具（小项目埋 3-4 个已知漏洞，内容只有出题人知道）→ agent 用 whitebox-audit skill 审计 → 验收：按决策链走完（选入口→基线扫描→确认→求证）且找出埋的雷。
- [x] **pentest 域实战**：造靶标服务（带已知漏洞的小 web 服务，跑在宿主机、VM 可达）→ agent 用 pentest skill 从 recon 开打 → 验收：走完「侦察→枚举→利用」决策链拿到 flag。
- [x] **ai-security 域实战**：靶标 = 自家 zhishi agent（应用层提示注入：工具返回/文件里埋指令，看 agent 是否被带跑）——自有产品，授权无瑕疵；顺手回答「自家产品抗不抗注入」。验收：探针集跑完 + 结果分级 + 报告留痕。
- 三域共用验收：各一条 dogfood 成功记录落 `research_events`；每域跑完按实战结果修正对应 skill（方法论缺口/工具问题/信号描述）。

> 授权口径（用户 2026-08-21 确认）：pentest 靶标为自造本机服务，ai-security 靶标为自家 agent——均在授权范围内，符合 skills 红线「目标人确认才进场」。
>
> 实际落地（2026-08-21）：三域各一轮 dogfood 全达成——whitebox：125 行埋雷项目 3 雷全中（SQLi/命令注入/路径穿越，均活体 PoC）+ 诱饵正确排除 + 额外中 2 个真问题（Content-Length DoS、无访问控制）；pentest：侦察（自装 nmap、6 端口、手工抓 banner）→ SQLi dump secrets → LFI 拿 flag 全链；ai-security：4 针间接注入探针 agent 全识别全拒（canary 零执行），复核更正了自动分级器的标记词误报。三域 `research_events` success 记录齐。skill 修正三处（小项目全读降级路径 / 裸机工具自装 + 手工 banner / 标记词判定要看上下文）+ **三域 skill 升 system（SYSTEM_SKILLS_VERSION 34→35）**——修正此前非 system 导致 seed-once 更新无法触达老安装的缺口。

---

## 1.1.7 —— 技术债版：IO 统一 + 引擎收拢 + god file 绞杀（已完成）

纯还债版，无用户可见功能。铁律：**纯搬移不改行为**——每个 commit 全量测试绿，测试断言一行不改。细节见 `docs/design/1.1.7-design.md`。

- [x] **① 文件 IO 纪律统一**——所有写 `~/.zhishi` 可变状态文件的点统一走 `withFileLock` + tmp+rename（范本：`environment/env-sessions.ts`）；首犯 `environment/selection.ts`（裸读写，1.1.6 核实时确认的活体坑）。读静态资源/bundled 的不动。验收：并发写不丢更新单测 + 全量回归绿。
- [x] **② 引擎状态收拢成类**——`chat-engine.ts` 的模块级 `let` 状态（sessionId/messages/queue/steering/busy/currentAbort/boundSessionMetaId/currentEnvKey/systemInitInfo 等）搬进 `ChatEngine` 类，24 个导出函数变方法；文件底部导出默认实例 + 原函数名 facade 委托，`admin-api.ts`/`index.ts` 调用点零改动。意义：可变状态边界显式化，2.0 多环境并行的地基（本步**不解** cron/TUI 语义耦合，只让耦合点可见）。验收：行为零变化，全量测试绿。
- [x] **③ god file 绞杀拆分（timebox：`index.ts` 13041 行 → ≤8000 行收手）**——主攻 `src/server/index.ts`：第一刀 cron（最内聚、与 1.1.6 耦合点最近）→ sessions 路由 → 路由表集中；每抽一块一个 commit。`admin-api.ts` 拆分优先级放低，本版不动。验收：行数达标 + 全量测试绿 + `npm run smoke` 5/5（VM 在线时）。

> 实际落地（2026-08-21）：① selection.ts 收编锁内读-改-写（并发写单测），其余候选甄别后不改（甄别清单见设计文档落地记录）；② 13 个状态字段收拢 + 20 个 facade，44 引擎用例零改动全绿；③ 四刀 13041→7660 行，顺手收编 writeSkillsConfig 锁（① 遗留项）。全量 1683 测试绿 + typecheck + eslint/depcruise 干净 + VM 在线 `npm run smoke` **5/5 全绿**。③ 剩余路由组（/api/agent/*、/chat/* 等）归日常随做随拆。

---

## 1.1.6 —— 会话分环境 + TUI 缺陷修复（已完成）

- [x] **修复 #2：`/env` 重新选择环境卡死**——根因已定位：`gateBusy` 成功路径不复位 + `enterGate()` 不重置（`app.ts:253/279/295`），二次进门所有键被吞。修复：`enterGate()` 入口复位 `gateBusy`；附带修复：重进 gate 按 Esc 应返回 chat 而非退出程序（区分 startup/reentry 来源）。验收：`/env` 打开列表可上下移动、Enter 选定生效、Esc 返回聊天界面。
- [x] **修复 #3：滚轮翻历史（已重新立项）**——原缺陷单已过时：鼠标捕获 2026-08-17 整体移除（`terminal-writer.ts:226-229`），滚轮当前无任何行为。实为「受控重新引入 wheel-only 捕获」：keymap 只放行 wheel 码 64/65（不开点击/拖拽，保住终端原生文本选择）。交互语义定案（方案 A）：任意态滚轮上滚 = 进入回看并翻历史，Esc 或滚到底回最新。验收：滚轮可翻历史，鼠标选择复制不受影响，Esc 回底正常。
- [x] **#4：会话按环境分线**——切换环境不重置、不串扰。映射结构 A1：独立映射文件 `env-sessions.json`（走 `withFileLock`），workspace × 环境键 → loopSessionId；`environment/select` 落盘后联动引擎切会话线（turn 运行中拒绝，提示先 Esc 中断）。已确认决策：①启动恢复改按「工作区 + 当前选定环境」接线（`restorePiSession` + `ensureAgentSession` 双处改造）；②`resetPiChat` 同步清对应映射，防旧历史复活；③映射键：env 按 envId、recipe 按 instanceId、host 单独一条线；④workspace 键统一规范化（防斜杠漂移裂线）；⑤cron 跟随当前选定环境的线，不特殊处理。验收：A/B 两环境各聊一段，来回切换各接各的历史，上下文不串场。

> 三项技术方案已核实定稿（2026-08-20），落地顺序：#2 → #3 → #4（#4 的联动入口依赖 #2 先修好）。根因分析与决策依据见 `docs/design/1.1.6-design.md`。
>
> 实际落地（2026-08-21）：三项全部实现；单测 1677 全绿 + typecheck + eslint/depcruise 干净。活体验收（`tmp/m6-env-lines.mjs`，host × pwn-vm 两线）：A/B 各聊一段来回切换各接各的历史（回放隔离正确）、映射双落盘、turn 运行中 select 拒绝、重启后续接当前环境线——全 PASS。VM 恢复后全量 `npm run smoke` 补跑 **5/5 全绿**（2026-08-21）；顺手修了 smoke 脚本三处陈旧/脆弱断言：m4b A1 队列断言适配 W1 steering 语义（1.0.0 起 busy 进 steering 队列，同 turn 注入响应只产一个 message-complete）、m4a 复跑前 reset（system-init 每条线只广播一次）、编排器套件间 10s pacing（防供应商限流）。

---

## 1.1.5 —— 多模型接入 + TUI 配置闭环（已完成）

- [x] **内置供应商端点扩充**：`PRESET_PROVIDERS` 增加 OpenAI 格式供应商——OpenAI、Moonshot/Kimi、通义 Qwen、智谱 GLM、硅基流动（聚合平台），每个带 baseUrl + `modelListUrl`（填 key 后自动拉模型列表）+ 内置常用模型清单。pi 层接 OpenAI completions 格式（pi-ai 已原生支持）。
- [x] **用户流程**：`zhishi model set-key <id> <key>` → 自动拉取模型列表 → 选模型 → `set-default`。真端点冒烟：OpenAI 格式 one-shot 真调用通过；服务端链路 curl 验证（model/list 8 家、set-key 拉列表、mcp enable/disable）通过。
- [x] **TUI 模型配置闭环**：`/model`（无参）状态卡（供应商/已配 key/当前默认/模型数）；`/model set-key <供应商id>` 隐藏输入填 key（终端 raw 模式不回显）→ 自动拉列表；`/model use <供应商id> <模型名>` 切换（带供应商前缀防重名）。
- [x] **MCP 开关进 TUI**：`/mcp enable <id>` / `disable <id>`（写盘 + 桥重载，当前会话生效）；add/remove 留 CLI（OAuth/多形态 spec 不适合 TUI 输入行）。

---

## 1.1.4 —— 情报体验 + 横切扩域（已完成）

- [x] **intel update 进度输出**：update 长回填时 CLI 端实时显示「已入库 N 条」（简单版，不做百分比估算——拉取前总量未知）。实现：sync 进度状态进 `intel/status`，CLI 轮询展示；同时加 update 并发互斥（第二个 update 返回「已有更新在跑」）。实跑验证通过（0→869 条实时刷新）。
- [x] **情报横切扩 pentest 域**：nuclei 模板清单索引（**只存目录不存正文**——与 exploit-db 同原则，模板内容给 GitHub 链接）。新表 `nuclei_templates`（cve_id/template_path）+ 同步进 `zhishi intel update`（**多源 fallback**：raw → jsdelivr → api.github.com contents，本机网络实测前两者 node 不可达）+ `--nuclei-file` 本地导入兜底 + `intel_search` 扩展「查 CVE 的现成检测模板」（**只做 CVE→模板这一个查询维度**）。实跑验证通过（4321 条入库，CVE-2021-44228/2023-23752/2024-3400 联查正确）。

---

## 1.1.1 —— 能力补齐：扩展面收敛（已完成）

- [x] **TUI 接入面补完（MCP / 插件）**：原规划「TUI 只接了 skills，MCP / 插件在 CLI 已可用，TUI 侧入口与状态展示待补」。
  实际落地（2026-08-19）：
  - MCP 工具接入引擎（`mcp__<server>__<tool>` 命名、启动即连接、单点失败不阻塞会话）+ `mcp/reload` 热重载（配置以磁盘为准）+ TUI `/mcp` 状态与刷新——配置后工具在会话可用
  - .zsp 加密插件体系整体移除（商业分发时代残留，与开源定位冲突）——扩展统一由 MCP + skills 承担

## 1.1.2 —— 情报横切最小落地（已完成）

- [x] 每个研究域的侦察阶段接一条情报通道——给引擎一个宿主侧情报检索工具（NVD / exploit-db），先接二进制域。
  实际落地（2026-08-19）：`intel.db` 本地索引（分级 minimal/window/full + maxSizeMb 自裁）+ `zhishi intel update/status`（NVD 增量/断点续传/重试，exploit-db CSV 去重）+ loop 工具 `intel_search`（FTS 检索/在线回源/结果截断）。
  验收达成：真实会话中情报被消费；实跑 window 档 15.7 万 CVE + 4.7 万 exploit。

---

## 1.1.3 —— 引擎深化（已完成）

- [x] **后台长驻进程稳定性闭环**：登记表落盘（重启恢复）+ poll 存活探测（.pid 一致性校验）+ turn 结束/reset 回收杀掉（暂定决策，替代方向「保留续跑+认领」见 `bg-reap.ts` 底稿）。活体验证中修复回收组杀（setsid 建组），二次验证进程无残留。
- [x] **经验反喂效果验收**：度量口径先行（`docs/design/distill-eval.md`——重复踩坑率/回合数，每域 ≥10 组可比任务）；当前 3 条样本，量化暂缓等数据。
- [x] **引擎底座升级回归**：`npm run smoke` 一键回归（m1→m3 活体全绿，任一失败 exit 1 阻断升级；SDK 对照脚本除名）。

---

## 未排版本

（原「各域 skills 实战深化」已收编进 1.1.8）

## 后续候选（未定版本）

- 发行链路收尾：macOS 构建冒烟、安装包自动更新链路真机验证（签名私钥归属待定，UPDATE 暂缓）；zhishi-updater 已接入三端构建脚本（1.2.3 后段）
- 1.2.x 度量期：专家知识引用率/脱困率基线——等真实使用攒数据（当前样本为零）
- 红队与恶意软件域重启评估（暂缓项）
- CVE 复现之外的实战 dogfood 扩展（视需要）

> 已收编/已放弃（防重复立项）：研究记录导出=1.2.0 已做；多环境并行的「跨环境子任务」切片经论证放弃（串行切环境已覆盖，1.2.x 讨论记录在案）；引擎多实例/TUI 多线同屏/跨机协同调度经判断非强需求砍掉（2026-08-22）；2.0 大版本暂缓（现有 2.0 候选撑不起大版本名分）。
