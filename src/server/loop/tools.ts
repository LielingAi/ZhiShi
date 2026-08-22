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
// env_bg — 环境内长驻进程通道（docs/env-bg-design.md）
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
      const promoteHint =
        event.outcome === 'fail'
          ? ''
          : `。这条经验若可复用,提示研究员可用 \`zhishi expert promote #${event.id}\` 晋升为专家知识(人审后生效)`;
      return {
        content: [{ type: 'text', text: `研究事件已记录(#${event.id} ${event.taskKind}/${event.outcome})${promoteHint}` }],
        details: { eventId: event.id },
      };
    },
  };
}
