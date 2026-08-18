/**
 * M3(D26)— subagent:子 loop 与 delegate_task 工具。
 *
 * 形态:
 *   - {@link spawnSubLoop} — 顺序(await)子 loop:独立 sessionId + 独立
 *     boundary hook,复用 runLoop。并行用 Promise.all 直接跑,不做调度器。
 *   - {@link createDelegateTaskTool} — 包成 pi 工具 `delegate_task`
 *     ({ task, envId? }),让主 loop 的模型能派发子任务;子 loop 结果
 *     摘要(最终文本)回注给主 loop。
 *
 * 收窄语义(硬约束,违反即 throw 不执行):
 *   - 子 loop 的工具白名单 ⊆ 父 loop(只能更小,不能更大);
 *   - 深度限 1:子 loop 里不再注册 delegate_task——结构性保证是
 *     spawnSubLoop 的默认工具集只有环境侧工具,delegate_task 只能由
 *     主 loop 显式注册;
 *   - envId 若提供,必须等于父 loop 绑定的环境 id(v1 单环境;子任务
 *     不能跳到父未授权的环境)。
 *
 * 会话:子 loop 默认独立 sessionId 并(可选)持久化到 loop-sessions,
 * 与主会话平级——子任务是可审计的独立工作史。
 */

import { Type, type Static } from '@earendil-works/pi-ai';
import type { AgentMessage, AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { randomUUID } from 'node:crypto';

import type { EnvironmentEntry } from '../../shared/config-types';
import { buildDefaultBoundaryRules, makeBoundaryHook, type BoundaryRule } from './boundary';
import { runLoop, type LoopEvent } from './loop';
import type { LoopModelResolution } from './pi-provider';
import { appendLoopMessages, newLoopSessionId } from './session';
import { createEnvExecTool, ENV_EXEC_TOOL_NAME } from './tools';

export const DELEGATE_TASK_TOOL_NAME = 'delegate_task';

export interface SpawnSubLoopOptions {
  prompt: string;
  /** 子任务目标环境(必须来自父 loop 的绑定,v1 单环境)。 */
  env: EnvironmentEntry;
  /** 模型运行时(与父 loop 同源;model 字段可覆盖降级)。 */
  resolution: LoopModelResolution;
  systemPrompt?: string;
  /** 父 loop 的工具白名单——收窄断言的基准。 */
  parentAllowedTools: string[];
  /** 子 loop 白名单(默认 [env_exec];必须 ⊆ parentAllowedTools)。 */
  allowedTools?: string[];
  /** 额外边界规则(在默认规则之后追加,只能更严)。 */
  extraRules?: BoundaryRule[];
  /** 覆盖子 loop 的工具集(默认 [env_exec(env)];不得含 delegate_task)。 */
  tools?: AgentTool[];
  sessionId?: string;
  /** 提供则把子 loop 产出持久化到该目录(独立 jsonl)。 */
  storeDir?: string;
  /**
   * W1(design-spec §8)— 子 loop 的每个 LoopEvent 透传给调用方(chat-engine
   * 用来把子 loop 的工具事件映射成 chat:subagent-tool-* SSE)。同步回调,
   * 抛错不影响子 loop。
   */
  onLoopEvent?: (event: LoopEvent) => void;
  maxTokens?: number;
}

export interface SubLoopResult {
  text: string;
  messages: AgentMessage[];
  sessionId: string;
  error?: string;
}

/** 收窄断言:子白名单 ⊆ 父白名单,且不包含 delegate_task(深度限 1)。 */
export function assertNarrowedWhitelist(parentAllowedTools: string[], childAllowedTools: string[]): void {
  const parent = new Set(parentAllowedTools);
  for (const tool of childAllowedTools) {
    if (tool === DELEGATE_TASK_TOOL_NAME) {
      throw new Error(`子 loop 不允许注册 ${DELEGATE_TASK_TOOL_NAME}(深度限 1)`);
    }
    if (!parent.has(tool)) {
      throw new Error(`子 loop 白名单越权:"${tool}" 不在父 loop 白名单内(只能收窄不能扩大)`);
    }
  }
}

export async function spawnSubLoop(options: SpawnSubLoopOptions): Promise<SubLoopResult> {
  const sessionId = options.sessionId ?? newLoopSessionId();
  const allowedTools = options.allowedTools ?? [ENV_EXEC_TOOL_NAME];
  assertNarrowedWhitelist(options.parentAllowedTools, allowedTools);

  const tools = options.tools ?? [createEnvExecTool(options.env)];
  if (tools.some((t) => t.name === DELEGATE_TASK_TOOL_NAME)) {
    throw new Error(`子 loop 工具集不得含 ${DELEGATE_TASK_TOOL_NAME}(深度限 1)`);
  }

  const beforeToolCall = makeBoundaryHook(options.env, {
    allowedTools,
    ...(options.extraRules
      ? { rules: [...buildDefaultBoundaryRules({ allowedTools }), ...options.extraRules] }
      : {}),
  });

  let text = '';
  let error: string | undefined;
  let messages: AgentMessage[] = [];
  for await (const event of runLoop({
    prompt: options.prompt,
    systemPrompt: options.systemPrompt
      ?? '你是安全研究子任务执行器。完成派发给你的具体任务,用 env_exec 在研究环境内查证,直接给出结论。',
    model: options.resolution.model,
    models: options.resolution.models,
    getApiKey: options.resolution.getApiKey,
    tools,
    beforeToolCall,
    maxTokens: options.maxTokens,
  })) {
    if (options.onLoopEvent) {
      try { options.onLoopEvent(event); } catch { /* 事件回调不炸子 loop */ }
    }
    if (event.type === 'error') error = event.error;
    if (event.type === 'done') {
      messages = event.messages;
      const lastAssistant = [...event.messages].reverse().find((m) => m.role === 'assistant');
      text = lastAssistant
        ? lastAssistant.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
        : '';
    }
  }

  if (options.storeDir) {
    await appendLoopMessages(
      sessionId,
      messages,
      { model: options.resolution.modelId, providerId: options.resolution.providerId },
      { dir: options.storeDir },
    );
  }
  return { text, messages, sessionId, error };
}

// ---------------------------------------------------------------------------
// delegate_task 工具(主 loop 注册)
// ---------------------------------------------------------------------------

const delegateTaskParameters = Type.Object({
  task: Type.String({ description: '要派发给子代理的具体任务(自包含,写明要在研究环境里查证/执行什么)' }),
  agent: Type.Optional(Type.String({
    description: '子代理定义名(engine 装载 bundled-agents/<名> 的提示正文作为子代理人格/方法;缺省 = 通用子代理)',
  })),
  envId: Type.Optional(Type.String({ description: '目标环境 id;缺省 = 当前绑定环境。必须是父 loop 已绑定的环境。' })),
});

export type DelegateTaskParams = Static<typeof delegateTaskParameters>;

export interface DelegateTaskDetails {
  sessionId: string;
  /** W1 — 子任务 id(chat:subagent-* SSE 的关联键)。 */
  taskId: string;
  error?: string;
}

/**
 * W1(design-spec §8 拍肩膀)— delegate_task 生命周期通知。chat-engine
 * 注入,把 started/finished 广播成 chat:subagent-started/finished SSE;
 * finished 带结论摘要(子 loop 最终文本,由实现侧截断),不带过程。
 */
export interface DelegateTaskNotifier {
  started(taskId: string, description: string): void;
  finished(taskId: string, description: string, summary: string, error?: string): void;
}

export interface CreateDelegateTaskToolOptions {
  env: EnvironmentEntry;
  resolution: LoopModelResolution;
  /** 父 loop 白名单(收窄断言基准;通常含 delegate_task 自身)。 */
  parentAllowedTools: string[];
  /** 子 loop 白名单(默认 [env_exec],即比父少 delegate_task)。 */
  childAllowedTools?: string[];
  systemPrompt?: string;
  /** 可派发的子代理定义(engine 从 bundled-agents 装载);按名取正文。 */
  agents?: { name: string; body: string }[];
  storeDir?: string;
  /** W1 — 生命周期通知(chat:subagent-started/finished 的产生点)。 */
  notify?: DelegateTaskNotifier;
  /** W1 — 透传给 spawnSubLoop 的子 loop 事件出口(chat:subagent-tool-* 的产生点)。 */
  onLoopEvent?: (taskId: string, event: LoopEvent) => void;
  /** 测试注入:替换 spawnSubLoop 实现。 */
  spawn?: (options: SpawnSubLoopOptions) => Promise<SubLoopResult>;
}

/**
 * 主 loop 的 delegate_task 工具。execute 顺序 await 子 loop,把子 loop
 * 的最终文本作为摘要回注;子 loop 的独立 sessionId 进 details(可审计)。
 */
export function createDelegateTaskTool(
  options: CreateDelegateTaskToolOptions,
): AgentTool<typeof delegateTaskParameters, DelegateTaskDetails> {
  const childAllowedTools = options.childAllowedTools ?? [ENV_EXEC_TOOL_NAME];
  // 构造期即断言收窄(失败早炸,不等到模型调用)。
  assertNarrowedWhitelist(options.parentAllowedTools, childAllowedTools);
  const spawn = options.spawn ?? spawnSubLoop;

  return {
    name: DELEGATE_TASK_TOOL_NAME,
    label: '派发子任务',
    description:
      '把一个具体、自包含的子任务派发给子代理在同一研究环境内执行(独立会话),' +
      '子代理可用 env_exec 查证环境事实,完成后把结论摘要返回给你。' +
      '适合需要多步环境操作的独立子目标;子代理不能再派发子任务。',
    parameters: delegateTaskParameters,
    execute: async (_toolCallId, params): Promise<AgentToolResult<DelegateTaskDetails>> => {
      if (params.envId && params.envId !== options.env.id) {
        throw new Error(
          `子任务目标环境 "${params.envId}" 未授权:父 loop 绑定的是 "${options.env.id}"(v1 单环境,子任务不能跳环境)`,
        );
      }
      const taskId = randomUUID();
      const description = params.task;
      // agent 参数 → 子代理定义正文作为子 loop 系统提示(engine 装载)。
      let subPrompt = options.systemPrompt;
      if (params.agent) {
        const agent = options.agents?.find((a) => a.name === params.agent);
        if (!agent) {
          throw new Error(`未知子代理 "${params.agent}"(可用:${(options.agents ?? []).map((a) => a.name).join('/') || '无'})`);
        }
        subPrompt = agent.body;
      }
      options.notify?.started(taskId, description);
      let result: SubLoopResult;
      try {
        result = await spawn({
          prompt: params.task,
          env: options.env,
          resolution: options.resolution,
          systemPrompt: subPrompt,
          parentAllowedTools: options.parentAllowedTools,
          allowedTools: childAllowedTools,
          storeDir: options.storeDir,
          ...(options.onLoopEvent ? { onLoopEvent: (event: LoopEvent) => options.onLoopEvent!(taskId, event) } : {}),
        });
      } catch (err) {
        // 子 loop 异常也要发 finished(TUI 后台段不留泄漏的 started)。
        const message = err instanceof Error ? err.message : String(err);
        options.notify?.finished(taskId, description, '', message);
        throw err;
      }
      const summary = result.error
        ? `子任务执行失败:${result.error}`
        : result.text || '(子任务无文本结论)';
      options.notify?.finished(taskId, description, summary, result.error);
      return {
        content: [{ type: 'text', text: `[子任务结论 session=${result.sessionId}]\n${summary}` }],
        details: { sessionId: result.sessionId, taskId, error: result.error },
      };
    },
  };
}
