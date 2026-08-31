/**
 * 1.2.7(A)— 实时上下文管理核心:切分 → 标注 → 采样锚定 → 注意力布局。
 *
 * 设计稿 docs/design/1.2.7-design.md §二的实现,纯函数为主、无 LLM 调用:
 *
 *   切分(segmentContext):以 user 消息为 turn 边界切段,每段推断研究
 *     阶段(phase:anchor/recon/analysis/construction/execution/
 *     evaluation)——段内 toolCall 名 + 命令/正文关键词确定性打分,取
 *     最高;无信号继承上一段 phase(研究阶段粘性);首段恒为 anchor。
 *   标注:每段携带 phase、token 估算(chars/4 同 pi 口径)、存活契约
 *     命中行摘录(原文)、工具名录、距末尾段数(age)。标注是纯数据,
 *     不进上下文——进上下文的是布局产物。
 *   采样锚定(compactBySegments):必保 = anchor 段 ∪ 最近 N 段当前阶段
 *     段(KEEP_CURRENT_PHASE_SEGMENTS,实测修正:全保会空转)∪ key 段;
 *     可压缩集从最老段起逐个 stub 化直到估算 ≤ 目标——压缩比例由内容
 *     构成锚定,不是预设档位。
 *   布局:anchor 原文在头、stub/key 段按段序居中(矮 stub 最小化
 *     「去中间」损耗)、当前阶段原文在尾。stub 是合法 user 消息,不
 *     伪造 assistant 发言;命中行是原文摘录不是改写。
 *
 * 存活契约(KEY_MESSAGE_PATTERNS 一族)也住在这里:标注需要它做
 * 行级命中摘录,而它又是 compaction.ts 的对外契约——本文件是叶子
 * 模块(不 import compaction),由 compaction.ts 转发导出以保持
 * 既有引用兼容(no-circular 红线)。
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core';

// ---------------------------------------------------------------------------
// 存活契约(1.2.7 扩三族;error 收窄语义维持 1.2.6 不动)
// ---------------------------------------------------------------------------

/**
 * 关键消息标记:研究状态存活线。exitCode≠0(死路/障碍)、CVE 编号、
 * flag 形态(突破证据)、[redacted](审计痕迹)。
 *
 * 1.2.7 扩三族(设计 §2.4,修「两头漏」,保持保守宁多勿缺):
 * - 中文突破/约束:拿到shell/权限提升/提权成功/复现成功/利用成功/
 *   突破口/不可写/拒绝访问;
 * - exit=0 约束事实:exit=0 且同文本含排除性结论词(不可写/不存在/
 *   关闭/denied/not found/unavailable)——见 hasConstrainedFact,
 *   需要跨行组合判定,不单列正则;
 * - fuzz 崩溃信号:SIGSEGV/SIGABRT/SIGILL/SIGFPE/AddressSanitizer/
 *   ASAN/core dumped/crash(与 binary 域 signals 对齐)。
 */
export const KEY_MESSAGE_PATTERNS: ReadonlyArray<RegExp> = [
  /exit=[1-9]\d*/,
  /CVE-\d{4}-\d{4,}/i,
  // 1.2.7 活体实测补:CWE 编号(白盒审计结论的事实锚——只有 CVE 没有
  // CWE 时,被 stub 的白盒段的「CWE-787 at copy.c:118」行不进摘录,
  // 模型只能引用到 filler 段的 CWE-89)。
  /CWE-\d+/i,
  /flag\{[^}]*\}/i,
  /\[redacted/,
  // 中文突破/约束族
  /拿到\s*shell/i,
  /权限提升|提权成功|复现成功|利用成功|突破口/,
  /不可写|拒绝访问/,
  // fuzz 崩溃信号族
  /SIGSEGV|SIGABRT|SIGILL|SIGFPE/,
  /AddressSanitizer|\bASAN\b|core dumped/i,
  /\bcrash(?:ed|ing|es)?\b/i,
];

/** exit=0 约束事实:成功退出但正文是排除性结论(死路的一种,1.2.7)。 */
const EXIT_ZERO = /exit=0/;
const EXIT_ZERO_EXCLUSION = /不可写|不存在|关闭|denied|not\s+found|unavailable/i;

export function hasConstrainedFact(text: string): boolean {
  return EXIT_ZERO.test(text) && EXIT_ZERO_EXCLUSION.test(text);
}

const ERROR_SIGNAL = /\berror\b/i;
/** 良性 error 搭配(剥离后再判):否定式与错误处理机制名。 */
const ERROR_BENIGN = /\b(?:no|not|without|zero|0)\s+errors?\b|\berrors?\s*[-_]?(?:handling|handler|handlers|handle)\b|\berror-free\b/gi;

/** error 信号判定:逐行剥离良性搭配后仍命中 \berror\b 才算(不误裁真错误)。 */
export function hasErrorSignal(text: string): boolean {
  for (const line of text.split('\n')) {
    if (ERROR_SIGNAL.test(line.replace(ERROR_BENIGN, ''))) return true;
  }
  return false;
}

/** 提取消息的全部文本(user 字符串 content / 各类 content 块)。 */
export function messageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const b = block as Record<string, unknown>;
      if (typeof b.text === 'string') return b.text;
      if (typeof b.thinking === 'string') return b.thinking;
      if (b.type === 'toolCall') return `${String(b.name ?? '')} ${JSON.stringify(b.arguments ?? {})}`;
      return '';
    })
    .join('\n');
}

/** 关键消息判定:toolResult 一律先看内容;任何角色文本命中标记即关键。 */
export function isKeyMessage(message: AgentMessage): boolean {
  const text = messageText(message);
  if (!text) return false;
  return (
    KEY_MESSAGE_PATTERNS.some((p) => p.test(text)) ||
    hasErrorSignal(text) ||
    hasConstrainedFact(text)
  );
}

/** 单行是否命中存活契约(摘录用;exit=0 约束族按整段判定后取排除词行)。 */
function isKeyHitLine(line: string, constrained: boolean): boolean {
  return (
    KEY_MESSAGE_PATTERNS.some((p) => p.test(line)) ||
    ERROR_SIGNAL.test(line.replace(ERROR_BENIGN, '')) ||
    (constrained && (EXIT_ZERO_EXCLUSION.test(line) || EXIT_ZERO.test(line)))
  );
}

const MAX_KEY_HIT_LINES = 3;
const KEY_HIT_LINE_CHARS = 120;

/** 存活契约命中行原文摘录(限 3 行、每行 120 字符——喂 stub,必须矮)。 */
export function keyHitLines(text: string): string[] {
  const constrained = hasConstrainedFact(text);
  const hits: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || !isKeyHitLine(line, constrained)) continue;
    hits.push(line.length > KEY_HIT_LINE_CHARS ? `${line.slice(0, KEY_HIT_LINE_CHARS)}…` : line);
    if (hits.length >= MAX_KEY_HIT_LINES) break;
  }
  return hits;
}

// ---------------------------------------------------------------------------
// token 估算(1.2.7 活体实测校准)
// ---------------------------------------------------------------------------

/**
 * pi 的 chars/4 对中文/密集符号文本系统性低估——活体实测(K2.7,中文
 * filler 历史):估算 226K tok,API 实报 521878 tok,偏差 2.3 倍,第一
 * 次调用直接撞 400(由溢出兜底接住)。按字符类分档校准:CJK/全角 ≈
 * 1 tok/字符,其余 ≈ 2.5 字符/tok(hex/符号密集的安全输出比英文散文
 * 费 token)。仍是启发式:阈值 0.8 的 20% 余量吸收残余偏差(1.5.3 起
 * 判定侧再叠 meta 持久化校准系数,见 compaction.evaluateCompaction)。
 */
const CJK_CHAR = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/gu;

/** 文本 token 估算(CJK 校准)。 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK_CHAR)?.length ?? 0;
  return Math.ceil(cjk + (text.length - cjk) / 2.5);
}

/** 消息 token 估算:文本按 CJK 校准;图片块按 pi 口径(4800 字符 ≈ 1200 tok/张)。 */
export function estimateMessageTokens(message: AgentMessage): number {
  const content = (message as { content?: unknown }).content;
  let images = 0;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b && typeof b === 'object' && (b as { type?: string }).type === 'image') images++;
    }
  }
  return estimateTextTokens(messageText(message)) + images * 1200;
}

// ---------------------------------------------------------------------------
// 消息结构工具(tool 配对闭包不动点——API tool_call_id 契约)
// ---------------------------------------------------------------------------

/** 消息里 toolCall 块的 id 集合(assistant)。 */
export function toolCallIdsOf(message: AgentMessage): string[] {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((b): b is { type: 'toolCall'; id: string } =>
      !!b && typeof b === 'object' && (b as { type?: string }).type === 'toolCall' && typeof (b as { id?: unknown }).id === 'string')
    .map((b) => b.id);
}

/** 消息里 toolCall 块的工具名录(assistant,去重保序——段标注用)。 */
export function toolCallNamesOf(message: AgentMessage): string[] {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  const names: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    const block = b as { type?: string; name?: unknown };
    if (block.type === 'toolCall' && typeof block.name === 'string' && !names.includes(block.name)) {
      names.push(block.name);
    }
  }
  return names;
}

/** toolResult 消息对应的 toolCallId。 */
export function toolResultCallId(message: AgentMessage): string | undefined {
  if (message.role !== 'toolResult') return undefined;
  const id = (message as { toolCallId?: unknown }).toolCallId;
  return typeof id === 'string' ? id : undefined;
}

/**
 * tool 配对闭包:tool_use 与 tool_result 必须成对存活——只留一半会让
 * Anthropic API 报 "tool_call_id is not found"(实测)。反复扩张直到
 * 不动点:kept toolResult ⇒ 其 toolCall 所在 assistant 也 keep;
 * kept toolCall ⇒ 其 toolResult 也 keep。
 *
 * 段级压缩整段取舍,结构上天然不拆对——生产路径不调用本函数;当前
 * 仅单测用它对压缩产物做闭包不动点校验(配对不拆的回归证据)。
 */
export function expandToolPairs(messages: AgentMessage[], keep: Set<number>): Set<number> {
  const result = new Set(keep);
  let changed = true;
  while (changed) {
    changed = false;
    const keptCallIds = new Set<string>();
    for (const i of result) {
      for (const id of toolCallIdsOf(messages[i])) keptCallIds.add(id);
    }
    for (let i = 0; i < messages.length; i++) {
      const callId = toolResultCallId(messages[i]);
      if (callId === undefined) continue;
      const hasResult = result.has(i);
      const hasCall = keptCallIds.has(callId);
      if (hasResult && !hasCall) {
        // 找回携带该 toolCall 的 assistant 消息
        for (let j = 0; j < messages.length; j++) {
          if (!result.has(j) && toolCallIdsOf(messages[j]).includes(callId)) {
            result.add(j);
            changed = true;
          }
        }
      } else if (!hasResult && hasCall) {
        result.add(i);
        changed = true;
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// 切分 + 相位推断(设计 §2.1)
// ---------------------------------------------------------------------------

export type ResearchPhase =
  | 'anchor'
  | 'recon'
  | 'analysis'
  | 'construction'
  | 'execution'
  | 'evaluation';

/**
 * 段内子段的消息数上限(1.2.7 场景实测 S4/E5 修正):段以 user 为界,但
 * 真实长会话是「一个任务 → 几十上百轮工具调用」——单段巨型化后段级
 * 压缩无可 stub(全段是当前段),直接掉第二档截断。超过上限的段在
 * **工具轮边界**再切子段(assistant 含 toolCall 起新轮;toolResult 永不
 * 作子段起点,配对不拆),相位逐子段推断(链内继承粘性同段间规则)。
 */
export const MAX_SEGMENT_MESSAGES = 12;

/**
 * 相位信号:段内 toolCall 名 + 命令/正文关键词(messageText 已把
 * toolCall 的 name+arguments 折进文本,同一份文本覆盖两类信号)。
 * 每个正则命中计 1 分;打分取最高;打平取研究循环中更靠后的阶段
 * (信号共存视为工作已推进)。
 */
const PHASE_SIGNALS: ReadonlyArray<{ phase: Exclude<ResearchPhase, 'anchor'>; patterns: RegExp[] }> = [
  // 1.4.6 相位体系修复（golang 取证 P0）：词表原是渗透口味——白盒/二进制
  // 研究的侦察活动（装工具链/枚举源码/CVE 情报/攻击面梳理）一个匹配不上，
  // recon 全程 0 段；同时「验证」泛词把环境准备/下载校验顶成 evaluation×4。
  // 扩域信号 + evaluation 去掉裸「验证」（复测/回归/验收/评估/结论保留）。
  { phase: 'recon', patterns: [/\bnmap\b/i, /\bmasscan\b/i, /扫描/, /枚举/, /\bgarak\b/i, /子域名/, /指纹/, /攻击面/, /侦察/, /梳理/, /盘点/, /情报/, /\bCVE-\d+/i, /toolchain/i, /工具链/, /下载/, /安装/] },
  { phase: 'analysis', patterns: [/\bgrep\b/i, /审计/, /反汇编/, /\breadelf\b/i, /\bida\b/i, /数据流/, /污点/, /源码/, /静态分析/, /codegen/i, /lowering/i, /\bssa\b/i, /类型检查/, /汇编/] },
  { phase: 'construction', patterns: [/\bexp\b/i, /\bpoc\b/i, /\bpayload\b/i, /脚本/, /harness/i, /seed/i, /构造/, /驱动/] },
  { phase: 'execution', patterns: [/\bexploit\b/i, /\bshell\b/i, /会话/, /fuzz/i, /复现/, /崩溃/, /\bcrash\b/i, /\basan\b/i] },
  { phase: 'evaluation', patterns: [/复测/, /回归/, /验收/, /评估/, /\bflag\b/i, /flag\{[^}]*\}/i, /结论/] },
];

/**
 * 相位推断:首段恒 anchor;其余段按信号打分取最高(打平取靠后阶段);
 * 无信号继承上一段 phase(研究阶段粘性,连续工具调用属同一阶段)——
 * 但**不继承 anchor**(1.2.7 场景实测 S4/E5 修正:anchor 是任务陈述不
 * 是研究阶段,继承它会让整段历史相位坍缩成 anchor,「当前阶段必保」
 * 随之失效);链上还没有非 anchor 相位时落 'recon'(研究从侦察起步的
 * 缺省,误判代价方向是多留)。
 */
export function inferPhase(
  text: string,
  previousPhase: ResearchPhase | undefined,
  isAnchorSegment: boolean,
): ResearchPhase {
  if (isAnchorSegment) return 'anchor';
  let best: ResearchPhase | undefined;
  let bestScore = 0;
  for (const { phase, patterns } of PHASE_SIGNALS) {
    let score = 0;
    for (const p of patterns) if (p.test(text)) score++;
    if (score > 0 && score >= bestScore) {
      best = phase;
      bestScore = score;
    }
  }
  return best ?? (previousPhase && previousPhase !== 'anchor' ? previousPhase : 'recon');
}

// ---------------------------------------------------------------------------
// 标注(设计 §2.2,纯数据不进上下文)
// ---------------------------------------------------------------------------

export interface ContextSegment {
  /** 段号(0 起,按出现顺序)。 */
  index: number;
  /** 在 messages 中的起始下标(含)。 */
  start: number;
  /** 在 messages 中的结束下标(不含)。 */
  end: number;
  phase: ResearchPhase;
  /** 段内消息 estimateMessageTokens 求和(CJK 校准口径,见函数注释)。 */
  tokens: number;
  /** 段内 toolCall 工具名录(去重保序)。 */
  toolNames: string[];
  /** 存活契约命中行原文摘录(限条限长)。 */
  keyHits: string[];
  /** 段内是否有关键消息(key 段在采样锚定中必保全量)。 */
  hasKey: boolean;
  /** 距末尾段数(0 = 末尾段)。 */
  age: number;
}

/**
 * 切分 + 标注:一条 user 消息起到下一条 user 前为一段;超过
 * MAX_SEGMENT_MESSAGES 的段在工具轮边界再切子段(见常量注释)。首个
 * user 之前的消息(异常输入)并入段 0;全程无 user(异常输入)则从
 * 消息 0 起切。空输入返回空数组。
 */
export function segmentContext(messages: AgentMessage[]): ContextSegment[] {
  // 子段起点候选:user 消息(段界)或带 toolCall 的 assistant(工具轮起点,
  // 仅当前子段已达上限才切);toolResult 永不作起点(配对不拆)。
  const starts: number[] = [];
  let chunkLen = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const isUser = m.role === 'user';
    const isToolTurn = toolCallIdsOf(m).length > 0;
    if (isUser || (isToolTurn && chunkLen >= MAX_SEGMENT_MESSAGES)) {
      starts.push(i);
      chunkLen = 0;
    }
    chunkLen++;
  }
  if (messages.length > 0) {
    if (starts.length === 0) starts.push(0);
    else starts[0] = 0; // 首个起点之前的消息并入段 0
  }
  const bounds = starts.map((start, i) => ({
    start,
    end: i + 1 < starts.length ? starts[i + 1] : messages.length,
  }));

  const segments: ContextSegment[] = [];
  let previousPhase: ResearchPhase | undefined;
  bounds.forEach(({ start, end }, index) => {
    const slice = messages.slice(start, end);
    const text = slice.map(messageText).join('\n');
    const phase = inferPhase(text, previousPhase, index === 0);
    previousPhase = phase;
    let tokens = 0;
    const toolNames: string[] = [];
    let hasKey = false;
    for (const m of slice) {
      tokens += estimateMessageTokens(m);
      for (const name of toolCallNamesOf(m)) {
        if (!toolNames.includes(name)) toolNames.push(name);
      }
      if (!hasKey && isKeyMessage(m)) hasKey = true;
    }
    segments.push({
      index,
      start,
      end,
      phase,
      tokens,
      toolNames,
      keyHits: keyHitLines(text),
      hasKey,
      age: 0, // 末尾统一回填
    });
  });
  const last = segments.length - 1;
  for (const seg of segments) seg.age = last - seg.index;
  return segments;
}

// ---------------------------------------------------------------------------
// 采样锚定 + 注意力布局(设计 §2.3 / §2.5)
// ---------------------------------------------------------------------------

/**
 * 裁后重估口径(设计 §2.6):一律纯估算(estimateMessageTokens 求和 +
 * 系统提示折算)——1.5.3 起未裁首判也不吃旧 assistant 的 usage 锚
 * (锚失真:压缩轮的 usage 是裁后体量;判定改用「全量启发式 × meta
 * 持久化校准系数」,见 compaction.evaluateCompaction)。系统提示是
 * 字符数入参,按中英混合保守口径 chars/2 折算(1.2.7 活体校准,见
 * estimateTextTokens 注释)。
 */
export function estimateMessagesTokens(messages: AgentMessage[], systemPromptChars = 0): number {
  let total = Math.ceil(systemPromptChars / 2);
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}

/** 段 stub:合法 user 消息,不伪造 assistant 发言。带段号/phase/关键
 * 信息(命中行原文摘录)/工具名录/「全文在会话存档」指针——矮,放在
 * 布局中段把「去中间」损耗最小化。
 * 1.5.3：stub 升级为指针卡（buildPointerCard，含收割引用 + jsonl 行区间
 * + recall 用法）——本函数保留为无收割时的兜底形态。
 * 1.5.4(A2-3)：兜底文案按「调用方是否有 recall 工具」分形态——子 loop
 * 无 recall,不印取回指引(印了模型照做即幻觉调用,被 boundary 拦)。 */
export function buildSegmentStub(
  segment: ContextSegment,
  options?: { /** 调用方上下文里是否有 recall 工具(缺省 true——主 loop 恒注册)。 */
    hasRecall?: boolean },
): AgentMessage {
  const keys = segment.keyHits.length > 0 ? segment.keyHits.map((l) => `「${l}」`).join(' ') : '无关键命中';
  const tools = segment.toolNames.length > 0 ? segment.toolNames.join('/') : '无工具调用';
  const pointer = options?.hasRecall === false
    ? '全文在会话存档(jsonl 全量未动;本上下文无取回工具,关键信息以本卡摘录为准)'
    : '全文在会话存档(jsonl 全量未动,需要时用 recall 工具按行区间取回)';
  return {
    role: 'user',
    content:
      `[段#${segment.index} ${segment.phase} 已压缩] 关键信息:${keys};` +
      `工具:${tools};${pointer}。`,
    timestamp: Date.now(),
  } as AgentMessage;
}

export interface SegmentCompactionResult {
  messages: AgentMessage[];
  /** 被 stub 化的段数。 */
  stubbedSegments: number;
  /** 被移除的原消息数(stub 段的整体体量;0 = 未裁剪)。 */
  prunedCount: number;
  /** stub 化后估算是否已 ≤ 目标(纯估算口径)。 */
  reachedTarget: boolean;
}

/**
 * 当前阶段全量保留的尾段数上限(1.2.7 场景实测 S4/E5 修正):「当前阶段
 * 所有段必保」在整会话同相位(如 300 段连续侦察)时会让必保集=全集,
 * 段级压缩空转掉第二档——全量保留收窄到**最近的 N 段当前阶段段**,更老
 * 的同相位段可 stub。anchor/key 段不受此限。N=8 对齐旧 keepRecentTurns
 * 的「最近几轮」直觉(段粒度比轮粗,取 2 倍)。
 */
export const KEEP_CURRENT_PHASE_SEGMENTS = 8;

/**
 * 选段（1.5.3 拆分——transform 需要先知道哪些段会被 stub，才能先收割再
 * 落指针卡）：可压缩集从最老段起逐个 stub 化直到纯估算 ≤ 目标。
 * 必保 = anchor 段 ∪ 最近 N 段当前阶段段 ∪ key 段（采样锚定不变）。
 */
export function selectSegmentsToStub(
  messages: AgentMessage[],
  segments: ContextSegment[],
  targetTokens: number,
  systemPromptChars = 0,
): Set<number> {
  if (segments.length === 0) return new Set();
  const currentPhase = segments[segments.length - 1].phase;
  const keepCurrentFull = new Set<number>();
  for (let i = segments.length - 1; i >= 0 && keepCurrentFull.size < KEEP_CURRENT_PHASE_SEGMENTS; i--) {
    if (segments[i].phase === currentPhase) keepCurrentFull.add(i);
  }
  const mustKeep = (seg: ContextSegment): boolean =>
    seg.index === 0 || keepCurrentFull.has(seg.index) || seg.hasKey;

  let total = estimateMessagesTokens(messages, systemPromptChars);
  const stubIdx = new Set<number>();
  for (const seg of segments) {
    if (total <= targetTokens) break;
    if (mustKeep(seg)) continue;
    stubIdx.add(seg.index);
    total = total - seg.tokens + estimateMessageTokens(buildSegmentStub(seg));
  }
  return stubIdx;
}

/**
 * 落 stub（1.5.3 拆分）：布局产物 [头] anchor 原文 → [中] stub/key 段按
 * 段序 → [尾] 最近当前阶段段原文。**被 stub 的段：段内 user 消息原文保留
 * （用户指令永不裁——1.5.3 硬钉死）+ 指针卡**（stubTextFn 可注入收割引用，
 * 缺省 buildSegmentStub 兜底形态）。tool_use/tool_result 配对不拆（配对
 * 闭包由段原子性保证）。
 */
export function applySegmentStubs(
  messages: AgentMessage[],
  segments: ContextSegment[],
  stubIdx: ReadonlySet<number>,
  stubTextFn: (seg: ContextSegment) => string = (seg) => String((buildSegmentStub(seg) as { content?: unknown }).content ?? ''),
): SegmentCompactionResult {
  if (segments.length === 0) {
    return { messages, stubbedSegments: 0, prunedCount: 0, reachedTarget: true };
  }
  const currentPhase = segments[segments.length - 1].phase;
  const keepCurrentFull = new Set<number>();
  for (let i = segments.length - 1; i >= 0 && keepCurrentFull.size < KEEP_CURRENT_PHASE_SEGMENTS; i--) {
    if (segments[i].phase === currentPhase) keepCurrentFull.add(i);
  }

  const out: AgentMessage[] = [];
  const pushOriginal = (seg: ContextSegment): void => {
    out.push(...messages.slice(seg.start, seg.end));
  };
  // 被 stub 段的 user 消息原文（用户指令永不裁——1.5.3 硬钉死）。
  const pushStubbed = (seg: ContextSegment): void => {
    for (let i = seg.start; i < seg.end && i < messages.length; i++) {
      if (messages[i].role === 'user') out.push(messages[i]);
    }
    out.push({
      role: 'user',
      content: stubTextFn(seg),
      timestamp: Date.now(),
    } as AgentMessage);
  };
  pushOriginal(segments[0]);
  let prunedCount = 0;
  let stubbedSegments = 0;
  for (const seg of segments.slice(1)) {
    if (keepCurrentFull.has(seg.index)) continue; // 尾段统一在最后按序追加
    if (stubIdx.has(seg.index)) {
      pushStubbed(seg);
      stubbedSegments++;
      prunedCount += seg.end - seg.start - 1; // user 原文保留,净裁 = 段体量 - user 消息
    } else {
      pushOriginal(seg);
    }
  }
  for (const seg of segments.slice(1)) {
    if (keepCurrentFull.has(seg.index)) pushOriginal(seg);
  }

  return {
    messages: out,
    stubbedSegments,
    prunedCount,
    reachedTarget: true, // 由调用方按阈值判定（兼容旧返回形状）
  };
}

/**
 * 采样锚定压缩:必保 = anchor 段 ∪ 最近 N 段当前阶段段 ∪ key 段;可压缩
 * 集从最老段起逐个 stub 化直到纯估算 ≤ 目标。布局产物:[头] anchor 原文
 * → [中] stub/key 段按段序 → [尾] 最近当前阶段段原文。整段取舍,
 * tool_use/tool_result 配对不拆(配对闭包由段原子性保证)。
 * 1.5.3：实现拆为 selectSegmentsToStub + applySegmentStubs（transform 层
 * 需要先收割再落指针卡）；本函数保持旧契约（兼容既有测试与调用方）。
 */
export function compactBySegments(
  messages: AgentMessage[],
  segments: ContextSegment[],
  targetTokens: number,
  systemPromptChars = 0,
): SegmentCompactionResult {
  if (segments.length === 0) {
    return { messages, stubbedSegments: 0, prunedCount: 0, reachedTarget: true };
  }
  const stubIdx = selectSegmentsToStub(messages, segments, targetTokens, systemPromptChars);
  const applied = applySegmentStubs(messages, segments, stubIdx);
  return { ...applied, reachedTarget: estimateMessagesTokens(applied.messages, systemPromptChars) <= targetTokens };
}
