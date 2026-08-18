/**

 * title-generator.ts — AI-powered session title generation.

 *

 * D20: builtin-only — provider-env 驱动的一次性 LLM 调用。(The

 * external-runtime path was removed with the external runtimes.)

 *

 * M1: SDK query() 单发路径已替换为 src/server/loop 的 pi one-shot——

 * 无子进程、无 bridge 回环（OpenAI 协议 provider 由 pi 原生支持）、

 * 无会话持久化。行为契约不变：单 turn、无工具面（一次性纯文本调用）、

 * 超时/失败返回 null（静默）。

 *

 * Always single-turn; never persists the title session. Timing: the backend

 * Title Service triggers this after AUTO_TITLE_MIN_ROUNDS (2) completed QA rounds;

 * before that the session shows the default truncated-first-message title.

 */



import { type ProviderEnv } from './agent-session';

import { isLikelyErrorTitle } from '../shared/titleFilters';

import { capTitleAtBoundary } from '../shared/sessionTitle';

import { oneShot } from './loop/one-shot';

import { resolveLoopModel, resolveLoopModelFromEnv } from './loop/pi-provider';



const TITLE_MAX_LENGTH = 30;

const TIMEOUT_MS = 15_000;


/** Max chars per user/assistant message when building context */

const PER_MESSAGE_LIMIT = 200;






const SYSTEM_PROMPT = `You are a session title generator for a chat app. Weeks later the user will

scan a long list of past sessions — your title must let them INSTANTLY

recognize which task this was, and tell it apart from similar ones.



A good title is a RETRIEVAL CUE, not a summary. Optimize for: seeing only this

title in a list, would the user think "oh, that's the time I did X"?



MUST keep — preserve the most distinctive anchor from the conversation,

verbatim, whenever one exists:

  - proper noun / project / product name  (高考, 知乎2077, ZhiShi, 望京北路)

  - issue / PR / version number           (#215, #223, 0.2.22)

  - specific file, API, library, error code (教宗通谕.docx, SSE, Cron, 402)

These exact strings are what make the session findable — keeping them matters

MORE than avoiding repetition or sounding clean.



A common effective shape is [domain/project] + [specific sub-task/artifact] +

[action], e.g. 高考题号展示调整. This is GUIDANCE, not a template — use whatever

phrasing is most recognizable for this particular conversation.



Rules:

  - Identify the real task across ALL rounds, not just round 1 — openers are

    often vague (回忆一下…, yo, 速度快不快).

  - Match the dominant language of the user's messages.

  - Short by default — a few words. Hard limit 30 characters (CJK counts as 1).

    If it doesn't fit, drop the least distinctive words, never the anchor.

  - NEVER use a full sentence, the user's whole request, or the assistant's

    reply/greeting as the title.

  - NEVER use generic fillers (帮助/问题/讨论/请求 · help/question/discussion)

    or meta-text about the title itself (对话标题应该是…, The title should be…).

  - If there is no real task yet (pure greeting / one-liner / test), output a

    short neutral label such as 新对话 — do NOT invent a topic.



Output ONLY the title. No quotes, no surrounding punctuation, no explanation.



Examples:

  tweak how exam question numbers render on a page   → 高考题号展示调整

  transcribe a recorded .m4a conversation            → 望京北路音频转写

  investigate issue #215 about Ctrl+F search nav     → #215 搜索导航 Bug 调研

  merge and release the 0.2.22 branch                → 0.2.22 合并发布

  conversation is just 你好 / 测试                     → 新对话`;



export interface TitleRound {

  user: string;

  assistant: string;

}



function buildUserPrompt(rounds: TitleRound[]): string {

  const parts = rounds.map((r, i) => {

    const user = r.user.slice(0, PER_MESSAGE_LIMIT);

    const assistant = r.assistant.slice(0, PER_MESSAGE_LIMIT);

    return `[Round ${i + 1}]\nUser: ${user}\nAssistant: ${assistant}`;

  });

  // Restate the hard constraints at the very END (recency): weaker / smaller

  // title-gen models follow the last instruction most reliably.

  return `<conversation>\n${parts.join('\n\n')}\n</conversation>\n\nWrite the session title. Keep the most distinctive anchor (name / number / file), match the user's language, ≤30 chars, output only the title.`;

}



/**

 * Clean up the generated title: remove surrounding quotes, punctuation, whitespace,

 * and truncate to TITLE_MAX_LENGTH characters.

 */

function cleanTitle(raw: string): string {

  let cleaned = raw.trim();

  // Remove surrounding quotes (single, double, Chinese quotes)

  cleaned = cleaned.replace(/^["'「『《【"']+|["'」』》】"']+$/g, '');

  // Remove trailing punctuation

  cleaned = cleaned.replace(/[。，、；：！？.,:;!?…]+$/, '');

  // Remove common AI preamble patterns

  cleaned = cleaned.replace(/^(标题[：:]|Title[：:])\s*/i, '');

  // Defense-in-depth: strip angle brackets so a model-injected "<script>" never reaches

  // a consumer that might render titles as HTML/Markdown raw. Frontend uses text nodes

  // today, but title is long-lived metadata and cheap to harden here.

  cleaned = cleaned.replace(/[<>]/g, '');

  cleaned = cleaned.trim();

  // #245 backstop: if the title looks like an upstream-error string (SDK 4xx/5xx

  // surface, openai-bridge [Error]: …) the title-gen LLM has either echoed

  // garbage input verbatim or the title-gen call itself failed and surfaced the

  // error. Reject so the caller treats it as "no title" and the frontend falls

  // back to its truncated-first-message default. Primary gate is the renderer

  // shouldRecordTurnForTitle; this catches paths it can't cover (loaded-history

  // reconstruction, title-gen call hitting its own 4xx).

  if (isLikelyErrorTitle(cleaned)) return '';

  // Boundary-aware cap: a blind slice(0,30) severs Latin words ("…SSE 流式调" →

  // "…SSE 流"); capTitleAtBoundary backs a mid-word cut off to the last space.

  // Pure CJK (no whitespace) still hard-cuts at the limit.

  return capTitleAtBoundary(cleaned, TITLE_MAX_LENGTH);

}



/**

 * Generate a short session title using the pi one-shot path (M1).

 * Accepts multiple QA rounds (typically 3) for richer context.

 * Uses the user's current model and provider — single-turn, non-persistent.

 * Returns cleaned title string on success, null on any failure (silent).

 */

export async function generateTitle(

  rounds: TitleRound[],

  model: string,

  providerEnv?: ProviderEnv,

): Promise<string | null> {

  const startTime = Date.now();



  try {

    // providerEnv 携带显式 provider（一次性调用可指向与 Tab 会话不同的

    // provider）；缺省时回落 config.json 的默认 loop 模型。两者都解析不出

    // = 模型不可用，按静默失败处理（同 SDK 路径的 null 语义）。

    const resolution = providerEnv

      ? resolveLoopModelFromEnv(providerEnv, model)

      : resolveLoopModel();



    if (!resolution) {

      console.warn('[title-generator] No usable provider/model (missing provider definition or API key)');

      return null;

    }



    const prompt = buildUserPrompt(rounds);



    // Race: LLM response vs timeout（超时即 null，静默）

    const timeoutPromise = new Promise<null>((resolve) => {

      setTimeout(() => resolve(null), TIMEOUT_MS);

    });



    const titleText = await Promise.race([

      oneShot({

        prompt,

        system: SYSTEM_PROMPT,

        model: resolution.model,

        models: resolution.models,

        apiKey: resolution.getApiKey(),

      }),

      timeoutPromise,

    ]);



    if (!titleText) {

      console.warn(`[title-generator] No title text returned (${Date.now() - startTime}ms)`);

      return null;

    }



    const cleaned = cleanTitle(titleText);

    console.log(`[title-generator] Generated title: "${cleaned}" (${Date.now() - startTime}ms, ${rounds.length} rounds)`);

    return cleaned.length > 0 ? cleaned : null;

  } catch (err) {

    console.warn('[title-generator] one-shot failed:', err);

    return null;

  }

}
