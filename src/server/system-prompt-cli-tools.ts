/**

 * CLI-backed capability hints injected into the system prompt.

 *

 * Each section teaches the AI about a ZhiShi-specific capability surfaced

 * through the `zhishi` CLI rather than as an MCP tool. The brief lives here;

 * the AI fetches full docs on demand via `zhishi <topic> readme`.

 *

 * Two scopes

 * ----------

 * - `buildCliToolsAppend(scenario, options)` — ZhiShi-CLI capability hints

 *   (cron CRUD, cron self-exit, memory retrieval, panels). Historically

 *   universal across runtimes since v0.2.11 dropped the in-process MCP

 *   servers (`cron-tools`, `im-cron`, `im-media`) in favour of the CLI.

 *   1.2.6 起按通道能力门控：多数段要求 agent 有宿主 shell 才能执行

 *   `zhishi` CLI；`options.hostShell === false`（pi 内置引擎，无宿主

 *   shell）时只保留不依赖 shell 的段（cron 自退标记），不教 agent 用它

 *   在当前通道里执行不了的东西。总开关是 `cliToolsEnabled`（见

 *   `buildSystemPromptAppend`）。

 * - `buildWidgetSection(scenario)` — generative-UI widget guidance. Universal:

 *   both builtin SDK and external runtimes load the design contract through

 *   `zhishi widget readme <module>` via their shell tool. There is no MCP

 *   path for widgets anymore — this is the single source of truth.

 */



import type { InteractionScenario } from './system-prompt';



// ===== Capability sections =====

//

// Each section is a self-contained block with one responsibility. We stack

// them conditionally per scenario in `buildCliToolsAppend` below.



const SECTION_TASK_SCHEDULE = `<zhishi-cli-task-schedule>

You can create, inspect, and manage ZhiShi tasks — including SCHEDULED tasks —

from the shell using the \`zhishi task\` CLI. A scheduled task is just a task

with an execution mode; there is no separate "cron" concept. Use this whenever

the user asks for anything like:



  "每 N 分钟 / 每小时 / 每天 / 定时 / 到 HH:MM 提醒 / 循环检查 / run on a schedule"



Trigger: any request that implies repetition over time.



DO NOT use the system \`cron\` / \`crontab\` / \`at\` / \`launchctl\` / \`schtasks\`

commands for this — they can't see ZhiShi state.



Quick reference (full docs: run \`zhishi task --help\`):

  zhishi task list                                     # see existing tasks

  zhishi task create-direct --name X --workspacePath /abs/ws \

      --taskMdContent "做什么、怎么做、验收标准" \

      --executionMode recurring --intervalMinutes 30     # every 30 min

  zhishi task create-direct --name X --workspacePath /abs/ws \

      --taskMdFile /tmp/task.md \

      --executionMode recurring --cronExpression "0 18 * * *" --cronTimezone "Asia/Shanghai"

      # Long / multiline instructions — write task.md to a file first (using

      # your normal file-writing tool) and pass --taskMdFile. This avoids

      # shell escape problems with quotes, newlines, and backticks.

  zhishi task update <taskId> --intervalMinutes 60     # retune the cadence

  zhishi task update-status <taskId> stopped           # pause a scheduled task

  zhishi task delete <taskId>                          # delete



Pass \`--json\` on any command for machine-parseable output. Non-zero exit means

the command failed; read stderr for the reason.

</zhishi-cli-task-schedule>`;



const SECTION_CRON_EXIT = `<zhishi-cli-task-exit>

You are currently running as a scheduled task AND the task creator enabled

"Allow AI to exit". If the task goal is fully achieved, or further executions

would be pointless or counterproductive, end the task early by including this

marker in your final output:



  [CRON_TASK_COMPLETE: goal achieved: ...]



The runtime detects the marker, marks the task complete, and stops future

executions. Only use this when you're sure — the user set up a schedule for a

reason. Do NOT use it to bail out of transient errors; retry instead.

</zhishi-cli-task-exit>`;


const SECTION_MEMORY = `<zhishi-cli-memory>

You have a long-term memory store, maintained automatically by the distill arc from real work history. When you need to recall the user's preferences, past decisions, acceptance criteria, or known pitfalls — run:



  zhishi memory search '<关键词>' [--kind reminder] [--limit N] [--json]



Results come ranked by effective score. Quote them faithfully and say they come from memory when relevant — recalled hits are logged, and memories the user later corrects are automatically penalized, so honest attribution keeps the loop healthy. Do not search on every turn; only when the current task genuinely depends on past context.

</zhishi-cli-memory>`;



const SECTION_PANEL = `<zhishi-cli-panel>

You can drive the user's VISIBLE embedded terminal panel in the workspace's right split. The user watches what you do there and can type into the same terminal.



  zhishi term open [--cwd <path>]       # prints terminalId; the panel auto-shows once

  zhishi term write <id> '<data>'       # send input (include \\n to run); --data-file <path> for multiline

  zhishi term read <id> [--cursor N]    # read new output since cursor (first call: all)

  zhishi term close <id>



When to use which: the visible terminal for long-running processes the user should keep (dev servers, watchers) or when transparency matters — your normal shell for everything else. For web browsing use the agent-browser skill (headless). Same permission flow as your shell.

</zhishi-cli-panel>`;



/**

 * Single source of truth for the widget trigger rule. Embedded into both the

 * system prompt's `SECTION_WIDGET` (always-on guidance) and the CLI's

 * `zhishi widget readme` README (`README_WIDGET` in admin-api.ts), so the

 * two surfaces never drift on what counts as a widget-worthy moment.

 */

export const WIDGET_TRIGGER_GUIDANCE = `your explanation reads better as a picture than as prose: data, comparison, trends, flows, steps, structure, hierarchy, timelines, relationships, tunable concepts, visual metaphors. Route on the content, not on whether the user said "visualize" — if drawing is clearer, draw.`;



const SECTION_WIDGET = `<zhishi-generative-ui>

You can embed a <generative-ui-widget> tag in your reply to a desktop user. The HTML inside renders inline as an interactive component — a peer of markdown tables and code blocks, just another medium for landing a point.



Use it whenever ${WIDGET_TRIGGER_GUIDANCE}



Skip it for: one-line answers, chitchat, content the user explicitly asked as plain text or code, IM bot sessions (widgets only render in desktop chat).



Before your first widget in a session, run \`zhishi widget readme <module> [<module> ...]\` via your shell tool (e.g. Bash) to load the design contract. Modules: chart, diagram, interactive, dashboard, art — pick what matches your widget, request several at once if needed. Skip if already pulled this session.

</zhishi-generative-ui>`;




// ===== Main entries =====



/**

 * Build the external-runtime CLI-tools appendix.

 *

 * Conditional stacking:

 *   - cron CRUD         hostShell only（需要宿主 shell 执行 zhishi CLI）

 *   - cron self-exit    only when scenario.type === 'cron' && aiCanExit

 *                       （纯输出标记机制，不依赖 shell，始终可达）

 *   - memory retrieval  hostShell only

 *   - panels            hostShell only

 *

 * Note: generative-UI widget guidance is NOT included here — it is universal

 * across runtimes and emitted separately by `buildWidgetSection()` from

 * `buildSystemPromptAppend()`.

 *

 * Returns an empty string when nothing applies（hostShell=false 且非 cron

 * 自退场景时即如此——调用方按零注入处理）。

 */

export interface CliToolsAppendOptions {

  /**

   * 当前通道里 agent 是否有宿主 shell（可执行 zhishi CLI）。默认 true

   * （外部 runtime 形态）；pi 内置引擎传 false，只保留不依赖 shell 的段。

   */

  hostShell?: boolean;

}

export function buildCliToolsAppend(scenario: InteractionScenario, options: CliToolsAppendOptions = {}): string {

  const hostShell = options.hostShell ?? true;

  const parts: string[] = [];



  // scheduled tasks (任务+schedule, no separate cron concept) — 需要宿主 shell

  if (hostShell) {

    parts.push(SECTION_TASK_SCHEDULE);

  }



  // cron self-exit — only inside a cron run that allows it（纯输出标记，不依赖 shell）

  if (scenario.type === 'cron' && scenario.aiCanExit) {

    parts.push(SECTION_CRON_EXIT);

  }



  if (hostShell) {

    // Long-term memory retrieval — 需要宿主 shell（zhishi memory search）

    parts.push(SECTION_MEMORY);

    // Visible panels (terminal) — 需要宿主 shell（zhishi term …）

    parts.push(SECTION_PANEL);

  }



  return parts.join('\n\n');

}



/**

 * Build the generative-UI widget guidance section.

 *

 * Universal across runtimes — emitted for every desktop scenario regardless of

 * whether the session is driven by the builtin Claude Agent SDK or an external

 * CLI. Both paths reach the design contract through `zhishi widget readme

 * <module>` invoked via their shell tool.

 *

 * Cron tasks run headless and their output isn't rendered in a live chat view

 * that can host a widget iframe, so widgets are gated to desktop scenarios

 * only.

 */

export function buildWidgetSection(scenario: InteractionScenario): string {

  return scenario.type === 'desktop' ? SECTION_WIDGET : '';

}

