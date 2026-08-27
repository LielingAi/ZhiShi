/**
 * M1 — pi 工具定义：把环境执行通道包装成 agent 可调用的工具。
 *
 * `env_exec` 是本仓「工具执行体挂环境层」的正式形态：工具的 execute
 * 体直接调用 env-exec 通道，命令在选定研究环境（VM guest / SSH 主机）
 * 内执行——不是宿主机。description 对模型写明这一点，避免它把环境
 * 事实（内核/主机名/已装工具）猜成宿主机的。
 */

import { Type, type Static } from '@earendil-works/pi-ai';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';

import type { EnvironmentEntry } from '../../shared/config-types';
import { execInEnvironment, DEFAULT_TIMEOUT_MS, type EnvExec } from './env-exec';
import {
  envBgKill,
  envBgList,
  envBgLog,
  envBgPoll,
  envBgStart,
  type BgExecOptions,
} from './bg-exec';
import { getBgRegistry, type BgRegistry } from './bg-registry';
import {
  recordResearchEvent,
  RESEARCH_BUG_CLASSES,
  RESEARCH_OUTCOMES,
  RESEARCH_TASK_KINDS,
  type ResearchBugClass,
  type ResearchOutcome,
  type ResearchTaskKind,
} from '../memory/store';
import {
  addEvidence,
  addFinding,
  addHypothesis,
  addQuestion,
  correctEntity,
  falsifyHypothesis,
  loadArchive,
  parseEntityRefs,
  resolveQuestion,
  type BroadcastFn,
  type FindingType,
} from './archive';

export const ENV_EXEC_TOOL_NAME = 'env_exec';

const envExecParameters = Type.Object({
  command: Type.String({ description: '要在研究环境内执行的 shell 命令（由环境的 shell 解释）' }),
  timeoutMs: Type.Optional(Type.Number({
    description: `单命令超时毫秒数（默认 ${DEFAULT_TIMEOUT_MS}）`,
    minimum: 1000,
  })),
});

export type EnvExecParams = Static<typeof envExecParameters>;

export interface EnvExecToolDetails {
  exitCode: number;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// env_bg — 环境内长驻进程通道（docs/spec/env-bg-design.md）
// ---------------------------------------------------------------------------

const envBgParameters = Type.Object({
  action: Type.String({
    enum: ['start', 'poll', 'log', 'kill', 'list'],
    description: 'start 发起后台进程 / poll 问状态 / log 读日志 / kill 杀 / list 列出全部',
  }),
  tag: Type.Optional(Type.String({ description: '进程句柄名（start 缺省自动生成；poll/log/kill 必填）' })),
  command: Type.Optional(Type.String({ description: 'start 时：要在环境内后台运行的完整 shell 命令' })),
  offset: Type.Optional(Type.Number({ description: 'log 时：字节偏移（0=尾部，缺省尾 8KB）', minimum: 0 })),
  limit: Type.Optional(Type.Number({ description: 'log 时：读取字节数（默认 8192，上限 64KB）', minimum: 1 })),
});

export type EnvBgParams = Static<typeof envBgParameters>;

export interface EnvBgToolDetails {
  action: string;
}

export interface CreateEnvBgToolOptions {
  exec?: EnvExec;
  environmentLabel?: string;
  /**
   * 生命周期回调(P2 Phase 2)：start 成功 / poll 观测到终态 / kill 成功时
   * 触发。chat-engine 接到后广播 chat:bg-started/finished,供 TUI 状态行
   * 静态段与退出插行消费。
   */
  onLifecycle?: (event:
    | { kind: 'started'; tag: string; pid: number; commandPreview: string }
    | { kind: 'finished'; tag: string; status: 'exited' | 'dead' | 'killed'; exitCode?: number }
  ) => void;
  /**
   * Phase 3 登记表（bg-registry.ts）：start 成功登记、poll 观测到终态 /
   * kill 后清除——回收杀掉（turn 结束/reset）据此知道要杀谁。缺省取
   * 全局单例（getBgRegistry，initPiChatEngine 初始化）；未初始化时为
   * null，登记降级为 no-op（不报错）。测试注入自建实例。
   */
  registry?: BgRegistry | null;
}

/** 结果文本：模型可读。 */
function formatEnvBgResult(action: string, body: string): string {
  return `[env_bg ${action}]\n${body}`;
}

/** 构造绑定到指定环境的 env_bg 工具。后台通道 = 薄编排层（见 bg-exec.ts）。 */
export function createEnvBgTool(
  entry: EnvironmentEntry,
  options: CreateEnvBgToolOptions = {},
): AgentTool<typeof envBgParameters, EnvBgToolDetails> {
  const envLabel = options.environmentLabel ?? entry.name ?? entry.id;
  const bgOptions: BgExecOptions = { exec: options.exec };
  const registry = options.registry !== undefined ? options.registry : getBgRegistry();
  return {
    name: 'env_bg',
    label: '在研究环境中发起/管理长驻后台进程',
    description:
      `在选定的安全研究环境 "${envLabel}" 内发起或管理后台长驻进程（fuzz 长跑、监听器、长扫描）。` +
      '发起即返回句柄（tag），之后可 poll 问状态 / log 读日志 / kill 杀掉 / list 列全部。' +
      '命令在环境内部跑，不是宿主机；tag 只允许字母数字_-。',
    parameters: envBgParameters,
    execute: async (_toolCallId, params): Promise<AgentToolResult<EnvBgToolDetails>> => {
      const tag = params.tag?.trim() || `bg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      let text: string;
      switch (params.action) {
        case 'start': {
          if (!params.command?.trim()) {
            throw new Error('env_bg start 需要 command（要在环境内后台运行的完整 shell 命令）');
          }
          const r = await envBgStart(entry, params.command, tag, bgOptions);
          if (!r.ok) throw new Error(r.error);
          const commandPreview = params.command.trim().slice(0, 100);
          // Phase 3：登记进宿主登记表（落盘，写失败不致命——见 bg-registry）。
          registry?.register({
            tag: r.tag,
            pid: r.pid,
            envId: entry.id,
            startedAt: Date.now(),
            commandPreview,
          });
          options.onLifecycle?.({
            kind: 'started',
            tag: r.tag,
            pid: r.pid,
            commandPreview,
          });
          text = `started tag=${r.tag} pid=${r.pid} log=${r.logPath}`;
          break;
        }
        case 'poll': {
          // Phase 3：登记表有 pid → 走存活探测通道（bg-exec knownPid）。
          // 探测失败（环境不可达）保守报 running+probeFailed，不误杀。
          const knownPid = registry?.get(tag)?.pid;
          const r = await envBgPoll(entry, tag, { ...bgOptions, knownPid });
          if (!r.ok) throw new Error(r.error);
          // 观测到终态 → 清登记 + 广播 finished(拍肩膀退出插行)。只发
          // 一次:服务端不做进程盯梢,终态是 poll 才可见的(Phase 2 语义)。
          // 已登记的 tag 探测报 missing(.pid 文件没了)同样按终态处理——
          // 环境重启把状态文件冲了,句柄已失效,广播按 dead(异常消失)。
          const probeTerminalMissing = r.status === 'missing' && knownPid !== undefined;
          if (r.status === 'exited' || r.status === 'dead' || probeTerminalMissing) {
            registry?.remove(tag);
            options.onLifecycle?.({
              kind: 'finished',
              tag,
              // 已登记的 tag 探测报 missing(.pid 文件没了)→ 按 dead(异常消失)。
              status: r.status === 'exited' || r.status === 'dead' ? r.status : 'dead',
              exitCode: r.exitCode,
            });
          }
          const line = r.status === 'exited'
            ? `status=exited exit=${r.exitCode ?? '?'}`
            : `status=${r.status}${r.pid ? ` pid=${r.pid}` : ''}`;
          text = `${line} tag=${tag}` +
            (r.probeFailed ? '（存活探测失败：环境不可达，保守保留 running 登记，不误杀）' : '');
          break;
        }
        case 'log': {
          const r = await envBgLog(entry, tag, params.offset ?? 0, params.limit ?? 8192, bgOptions);
          if (!r.ok) throw new Error(r.error);
          text = `tag=${tag} size=${r.size}${r.truncated ? ' (截断)' : ''}\n--- log ---\n${r.text || '(empty)'}`;
          break;
        }
        case 'kill': {
          const r = await envBgKill(entry, tag, bgOptions);
          if (!r.ok) throw new Error(r.error);
          const killed = r.outcome.startsWith('killed');
          if (killed) {
            registry?.remove(tag);
            options.onLifecycle?.({ kind: 'finished', tag, status: 'killed' });
          } else if (r.outcome === 'not-running' || r.outcome === 'missing') {
            // 进程已不在：登记表照清（不广播 finished——不是本次杀的，
            // TUI 侧状态行残留由下一次 poll/list 收敛，保持 Phase 2 契约）。
            registry?.remove(tag);
          }
          // kill-failed：进程可能还活着，登记保留（回收链下轮再试）。
          text = `tag=${tag} ${r.outcome}`;
          break;
        }
        case 'list': {
          const r = await envBgList(entry, bgOptions);
          if (!r.ok) throw new Error(r.error);
          text = r.entries.length === 0
            ? '(无后台进程)'
            : r.entries.map((e) => `- ${e.tag}`).join('\n');
          break;
        }
        default:
          throw new Error(`env_bg 未知 action: ${String(params.action)}`);
      }
      return {
        content: [{ type: 'text', text: formatEnvBgResult(params.action, text) }],
        details: { action: params.action },
      };
    },
  };
}

/** 工具结果文本：exit code + stdout/stderr 分节，模型可读。 */
export function formatEnvExecResult(r: { stdout: string; stderr: string; exitCode: number; truncated: boolean }): string {
  const sections = [`exit=${r.exitCode}`];
  sections.push(`--- stdout ---\n${r.stdout || '(empty)'}`);
  sections.push(`--- stderr ---\n${r.stderr || '(empty)'}`);
  if (r.truncated) sections.push('(output truncated: head+tail kept)');
  return sections.join('\n');
}

export interface CreateEnvExecToolOptions {
  /** 测试注入用；生产缺省走真实 ssh。 */
  exec?: EnvExec;
  /** 覆盖工具描述里的环境名（默认取 entry.name ?? entry.id）。 */
  environmentLabel?: string;
}

/**
 * 构造绑定到指定环境的 env_exec 工具。环境解析失败（未就绪/类型不支持）
 * 时 execute throw——pi 的 loop 会把 throw 转成 isError 的 tool result
 * 回注给模型（AgentTool.execute 契约：throw on failure）。
 */
export function createEnvExecTool(
  entry: EnvironmentEntry,
  options: CreateEnvExecToolOptions = {},
): AgentTool<typeof envExecParameters, EnvExecToolDetails> {
  const envLabel = options.environmentLabel ?? entry.name ?? entry.id;
  return {
    name: ENV_EXEC_TOOL_NAME,
    label: '在研究环境中执行命令',
    description:
      `在选定的安全研究环境 "${envLabel}"（隔离的 ${entry.kind} 环境）内执行一条 shell 命令，` +
      '返回 exit code / stdout / stderr。命令在环境内部运行，不是宿主机；' +
      '查环境事实（内核版本、主机名、已装工具、目标文件）时必须用它，不要猜测。' +
      '**预计超过 30 秒的命令（循环/长扫描/fuzz）不要用本工具等——用 env_bg 后台跑再 poll。**',
    parameters: envExecParameters,
    execute: async (_toolCallId, params): Promise<AgentToolResult<EnvExecToolDetails>> => {
      const result = await execInEnvironment(entry, params.command, {
        exec: options.exec,
        timeoutMs: params.timeoutMs,
      });
      if (!result.ok) {
        throw new Error(result.error);
      }
      return {
        content: [{ type: 'text', text: formatEnvExecResult(result) }],
        details: { exitCode: result.exitCode, truncated: result.truncated },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// research_log — 研究留痕（harness 原生能力,不是宿主执行）
// ---------------------------------------------------------------------------

/**
 * `research_log` 是蒸馏弧（D1）的留痕入口。dogfood #1 实测发现的结构性
 * 缺口：agent 在环境里干活,`zhishi research log` CLI 在宿主——env_exec
 * 里根本够不到。留痕是 harness 的一等 API（写自己的 research_events 库）,
 * 不是宿主命令执行,不破「宿主工具结构性不存在」的边界（D14）。
 */
export const RESEARCH_LOG_TOOL_NAME = 'research_log';

const researchLogParameters = Type.Object({
  task_kind: Type.String({ enum: [...RESEARCH_TASK_KINDS], description: `研究域:${RESEARCH_TASK_KINDS.join(' / ')}` }),
  outcome: Type.String({ enum: [...RESEARCH_OUTCOMES], description: `成败:${RESEARCH_OUTCOMES.join(' / ')}` }),
  summary: Type.String({ description: '成了什么 / 卡在哪 / 有效组合（一句话,蒸馏原料）。与专家知识冲突时在此写明冲突点(谁对谁错都是学习材料)' }),
  bug_class: Type.Optional(Type.String({ enum: [...RESEARCH_BUG_CLASSES], description: `漏洞类别(可空):${RESEARCH_BUG_CLASSES.join(' / ')}` })),
  trajectory_ref: Type.Optional(Type.String({
    description:
      '轨迹文件的工作区相对路径(可空)。纪律:产出 PoC/样本/截图等工件时必须挂环境内路径——' +
      '报告导出的证据回收按此登记批量拉回宿主,不挂=报告里该证据只能降级标注。',
  })),
  expert_refs: Type.Optional(Type.String({
    description:
      'expert 条目 id 列表,逗号分隔(可空,如 "3,12")。本结论/决策若依据了 expert_search 返回的专家条目,把条目 id 挂上——' +
      '报告标注与蒸馏追溯按此;不存在的 id 会被拒绝落库。',
  })),
});

export type ResearchLogParams = Static<typeof researchLogParameters>;

export interface ResearchLogToolDetails {
  eventId: number;
}

/** 解析 expert_refs 参数（逗号分隔 id 串 → 去重的正整数数组）；非法 token 抛错。 */
function parseExpertRefsParam(raw: string): number[] {
  const ids: number[] = [];
  for (const token of raw.split(',')) {
    const t = token.trim().replace(/^#/, '');
    if (!t) continue;
    const id = Number(t);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`research_log: expert_refs 含非法条目 id "${token.trim()}"（逗号分隔的正整数 id 列表）`);
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** 构造 research_log 工具;workspace 落库用(默认当前工作区路径)。 */
export function createResearchLogTool(
  workspace: string,
  options: { baseDir?: string } = {},
): AgentTool<typeof researchLogParameters, ResearchLogToolDetails> {
  return {
    name: RESEARCH_LOG_TOOL_NAME,
    label: '记录研究成败',
    description:
      '拿到 flag / 确认根因 / fuzz 出独有崩溃 / 研判完成 / 放弃时,记录一条研究成败事件(蒸馏弧原料)。' +
      '这是 harness 原生能力——直接落库,不要在环境里跑 zhishi CLI(环境里够不到)。' +
      '若结论/决策依据了 expert_search 返回的专家条目,把条目 id 挂上 expert_refs(报告与蒸馏按此追溯);' +
      '与专家知识冲突时在 summary 写明冲突点。结案留痕(success/stuck)后工具会返回晋升提示,请原样转达给研究员。',
    parameters: researchLogParameters,
    execute: async (_toolCallId, params): Promise<AgentToolResult<ResearchLogToolDetails>> => {
      const expertRefs = params.expert_refs ? parseExpertRefsParam(params.expert_refs) : undefined;
      const event = recordResearchEvent({
        workspace,
        taskKind: params.task_kind as ResearchTaskKind,
        outcome: params.outcome as ResearchOutcome,
        ...(params.bug_class ? { bugClass: params.bug_class as ResearchBugClass } : {}),
        summary: params.summary,
        ...(params.trajectory_ref ? { trajectoryRef: params.trajectory_ref } : {}),
        ...(expertRefs && expertRefs.length > 0 ? { expertRefs } : {}),
      }, options.baseDir);
      // 1.2.2 promote 常态化:结案(success/stuck)留痕成功后在返回文本里带晋升
      // 提示——harness 原生、零时序猜测;fail 不带(失败教训走蒸馏弧,不是专家知识)。
      // 1.4.6 E#N 口径:研究事件引用写作 E#N(与档案实体 H#/V#/C#/Q# 区分——
      // golang 取证 msg 354 实证裸 #N 编号混淆)。
      const promoteHint =
        event.outcome === 'fail'
          ? ''
          : `。这条经验若可复用,提示研究员可用 \`zhishi expert promote #${event.id}\` 晋升为专家知识(人审后生效)`;
      return {
        content: [{ type: 'text', text: `研究事件已记录(E#${event.id} ${event.taskKind}/${event.outcome})${promoteHint}` }],
        details: { eventId: event.id },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// research_archive — 研究档案（1.4.4：显式研究状态的写通道）
// ---------------------------------------------------------------------------

/**
 * 研究档案是「研究 = 过程 + 成果」的落地载体：假设/证据/结论/未决问题
 * 四类实体 + 证伪/纠正/解决操作。档案随研究持续更新，每轮注回模型上下文
 * （模型在显式状态上继续工作，不从历史脑补）；GUI 研究面板与它同源，
 * 人可读、可纠正（纠正是一等操作：人 > 专家知识 > 模型自证伪）。
 *
 * 与 research_log 分工：research_log 是**成败信号**（蒸馏弧原料，契约
 * 不动）；research_archive 是**研究状态**（全程账本，报告派生源）。
 * 两者并存不混——结案时两者都该有。
 */
export const RESEARCH_ARCHIVE_TOOL_NAME = 'research_archive';

export const ARCHIVE_FINDING_TYPES: FindingType[] = ['bug_class', 'primitive', 'constraint', 'fact'];

const archiveParameters = Type.Object({
  op: Type.String({
    enum: ['hypothesis', 'evidence', 'finding', 'question', 'falsify', 'resolve', 'correct'],
    description:
      '操作:hypothesis 立假设(可验证的断言) / evidence 记证据(实验观察到的结果) / '
      + 'finding 立结论(证据支撑的断言,挂 V# 引用) / question 立未决问题(还缺什么) / '
      + 'falsify 证伪自己的假设(必须,排除的路也是成果) / resolve 未决问题已解决 / '
      + 'correct 纠正自己的结论或证据(错了就改,留痕)',
  }),
  text: Type.Optional(Type.String({
    description: '实体正文(op=hypothesis/evidence/finding/question 必填;一句话说清,全文在流里)',
  })),
  findingType: Type.Optional(Type.String({
    enum: ARCHIVE_FINDING_TYPES,
    description: `结论类型(op=finding 可选):${ARCHIVE_FINDING_TYPES.join(' / ')}`,
  })),
  refs: Type.Optional(Type.String({
    description: '实体引用,逗号分隔(op 新增类可选):假设/问题挂派生依据,证据挂由哪个假设驱动,结论挂证据(V#N)——正反推论的机械锚',
  })),
  anchor: Type.Optional(Type.String({
    description: '来源标注(op 新增类可选):这条实体的证据在流的哪里——用「env_exec #N / 命令名 / 文件:行号」形态(如「env_exec #6 build_verify 重跑」「src/cJSON.c:261」),不要用「轮」(与 auto loop 轮次撞车,实机实证编号误导)',
  })),
  id: Type.Optional(Type.String({ description: '目标实体 id(op=falsify/resolve/correct 必填,如 H#1/V#1/C#1/Q#1)' })),
  reason: Type.Optional(Type.String({ description: '原因(op=falsify/correct 必填):错在哪、为什么' })),
  note: Type.Optional(Type.String({ description: '补充说明(op=resolve 可选):问题被什么解决了' })),
});

export type ArchiveToolParams = Static<typeof archiveParameters>;

export interface ArchiveToolDetails {
  entityId?: string;
}

export interface CreateArchiveToolOptions {
  /** 当前 loop 线(turn 快照线)——档案归属依据。 */
  getSessionId?: () => string;
  /** 当前轮 user 消息 id(来源锚,交互线才有;headless 线 undefined)。 */
  getAnchor?: () => { messageId?: string };
  /** 数据目录(测试注入临时目录)。 */
  dir?: string;
  /** 事件扇出(缺省不广播;生产由 engine 注入 sse.broadcast)。 */
  broadcastFn?: BroadcastFn;
}

/** 构造 research_archive 工具(harness 原生能力,无条件注册)。 */
export function createArchiveTool(
  options: CreateArchiveToolOptions = {},
): AgentTool<typeof archiveParameters, ArchiveToolDetails> {
  const getSessionId = options.getSessionId ?? (() => '');
  const getAnchor = options.getAnchor ?? ((): { messageId?: string } => ({}));
  const session = (): string => {
    const id = getSessionId();
    if (!id) throw new Error('research_archive: 会话未锚定(无 loop 线)');
    return id;
  };
  const common = () => ({ dir: options.dir, broadcastFn: options.broadcastFn });
  return {
    name: RESEARCH_ARCHIVE_TOOL_NAME,
    label: '更新研究档案',
    description:
      '研究档案是本会话的显式研究状态(假设/证据/结论/未决问题),随研究持续更新,每轮注回你的上下文。纪律:'
      + '①假设驱动实验,立假设后去做实验,evidence 挂假设引用;'
      + '②结论必须有证据支撑——finding 的 refs 必须挂已存在的 V# 证据实体(先 op=evidence 记证据再下结论,缺证据会被拒绝);'
      + '③证伪/纠错必须走 falsify/correct 操作留痕——实验推翻假设用 falsify,结论/证据错了用 correct;**不要把证伪写进 finding 文本里冒充成立**(排除的路也是成果,防止反复重访死路);'
      + '④目标不清/缺前提时立 question(未决问题),不要空转猜方向;'
      + '⑤每条实体一两句话,全文在对话流里,anchor 标注它在流的哪。',
    parameters: archiveParameters,
    execute: async (_toolCallId, params): Promise<AgentToolResult<ArchiveToolDetails>> => {
      const sid = session();
      const { messageId } = getAnchor();
      const base = {
        ...(messageId ? { anchorMessageId: messageId } : {}),
        ...(params.anchor?.trim() ? { anchorLabel: params.anchor.trim() } : {}),
        ...(params.refs?.trim() ? { refs: params.refs.trim() } : {}),
      };
      switch (params.op) {
        case 'hypothesis': {
          if (!params.text?.trim()) throw new Error('research_archive: hypothesis 需要 text');
          const snap = await addHypothesis(sid, { text: params.text, ...base }, common());
          const e = snap.entities.at(-1)!;
          return { content: [{ type: 'text', text: `研究档案已更新:${e.id} 假设已立(待验证)${e.links.length > 0 ? `,依据 ${e.links.join(' ')}` : ''}` }], details: { entityId: e.id } };
        }
        case 'evidence': {
          if (!params.text?.trim()) throw new Error('research_archive: evidence 需要 text');
          const snap = await addEvidence(sid, { text: params.text, ...base }, common());
          const e = snap.entities.at(-1)!;
          return { content: [{ type: 'text', text: `研究档案已更新:${e.id} 证据已记${e.links.length > 0 ? `(由 ${e.links.join(' ')} 驱动)` : ''}` }], details: { entityId: e.id } };
        }
        case 'finding': {
          if (!params.text?.trim()) throw new Error('research_archive: finding 需要 text');
          // 1.4.6 举证强度（cJSON dogfood 实证 P0）：结论必须有证据支撑——
          // refs 必须挂至少一个已存在的 V# 证据实体。模型第 3 轮退化为
          // 只写结论零证据引用,举证链结构断裂;约束放在工具层（addFinding
          // 模块层保持宽松,admin/迁移等合法写入不受影响）。
          const refs = parseEntityRefs(params.refs);
          if (refs.length === 0) {
            throw new Error(
              'research_archive: 结论必须有证据支撑——refs 请挂 V# 证据引用。'
              + '先 op=evidence 记录证据（实验观察/工具输出/数据流证明/用户陈述都算证据，可挂假设引用），再 finding refs 挂它。',
            );
          }
          const current = loadArchive(sid, { dir: options.dir });
          const evidenceIds = new Set(
            current.entities.filter((e) => e.kind === 'evidence').map((e) => e.id),
          );
          if (!refs.some((r) => evidenceIds.has(r))) {
            throw new Error(
              `research_archive: refs 中没有已存在的证据实体（${refs.join('、')}）——`
              + '先 op=evidence 记录证据，再 finding refs 挂 V# 引用。',
            );
          }
          const snap = await addFinding(
            sid,
            { text: params.text, findingType: params.findingType as FindingType | undefined, ...base },
            common(),
          );
          const e = snap.entities.at(-1)!;
          return { content: [{ type: 'text', text: `研究档案已更新:${e.id} 结论已立,证据 ${e.links.join(' ')}` }], details: { entityId: e.id } };
        }
        case 'question': {
          if (!params.text?.trim()) throw new Error('research_archive: question 需要 text');
          const snap = await addQuestion(sid, { text: params.text, ...base }, common());
          const e = snap.entities.at(-1)!;
          return { content: [{ type: 'text', text: `研究档案已更新:${e.id} 未决问题已立——先解决它再推进,不要空转` }], details: { entityId: e.id } };
        }
        case 'falsify': {
          if (!params.id) throw new Error('research_archive: falsify 需要 id(H#N)');
          if (!params.reason?.trim()) throw new Error('research_archive: falsify 需要 reason(错在哪、为什么)');
          await falsifyHypothesis(sid, params.id, params.reason, common());
          return { content: [{ type: 'text', text: `研究档案已更新:${params.id} 已证伪(${params.reason.slice(0, 80)})——排除的路也是成果,已留痕` }], details: { entityId: params.id } };
        }
        case 'resolve': {
          if (!params.id) throw new Error('research_archive: resolve 需要 id(Q#N)');
          await resolveQuestion(sid, { id: params.id, note: params.note }, common());
          return { content: [{ type: 'text', text: `研究档案已更新:${params.id} 已解决${params.note ? `(${params.note.slice(0, 80)})` : ''}` }], details: { entityId: params.id } };
        }
        case 'correct': {
          if (!params.id) throw new Error('research_archive: correct 需要 id(C#N/V#N)');
          if (!params.reason?.trim()) throw new Error('research_archive: correct 需要 reason(错在哪、为什么)');
          await correctEntity(sid, { id: params.id, by: 'model', reason: params.reason }, common());
          return { content: [{ type: 'text', text: `研究档案已更新:${params.id} 已纠正(${params.reason.slice(0, 80)})——引用它的条目已标记待复核` }], details: { entityId: params.id } };
        }
        default:
          throw new Error(`research_archive: 未知操作 ${params.op}`);
      }
    },
  };
}
