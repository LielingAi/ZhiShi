/**

 * zhishi — Self-Configuration CLI for ZhiShi

 *

 * A thin wrapper that parses CLI arguments and forwards them as HTTP requests

 * to the Sidecar's Admin API. All business logic lives in the Sidecar.

 *

 * Environment:

 *   ZHISHI_PORT — Sidecar port (injected by buildClaudeSessionEnv)

 *

 * No shebang here. `npm run build:cli` (esbuild) injects `#!/usr/bin/env node`

 * through `--banner:js` so the *built* `zhishi.js` artifact is what carries

 * the shebang. A leftover `#!/usr/bin/env bun` on this source file used to

 * stack with the banner and produced a TWO-shebang artifact (issue #107):

 * bun parses the first line as shebang, the second line `#!/usr/bin/env node`

 * is then read as JS and rejected as a syntax error. Same outcome under node.

 */



import { homedir } from 'os';

import { createInterface } from 'node:readline';

import { Agent, fetch as undiciFetch } from 'undici';



import { getZhiShiDataDir } from '../server/utils/app-dirs';

import {
  isResearchBugClass,
  isResearchOutcome,
  isResearchTaskKind,
  RESEARCH_BUG_CLASSES,
  RESEARCH_OUTCOMES,
  RESEARCH_TASK_KINDS,
} from '../server/memory/store';



import { runAgentLoop } from './tui/v2/entry';



// ---------------------------------------------------------------------------

// Port discovery

// ---------------------------------------------------------------------------



// Port is resolved after arg parsing (--port flag can override env)

let PORT = process.env.ZHISHI_PORT ?? '';

let BASE = '';



// ---------------------------------------------------------------------------

// Argument parsing

// ---------------------------------------------------------------------------



const rawArgs = process.argv.slice(2);



/** Parse CLI arguments into structured flags and positional args */

function parseArgs(args: string[]): { positional: string[]; flags: Record<string, unknown> } {

  const positional: string[] = [];

  const flags: Record<string, unknown> = {};

  const repeatable = new Set(['args', 'env', 'headers', 'models', 'model-names', 'var']);



  // Short-flag → long-flag mapping. Only specific aliases are mapped; bare `-` prefixed positional

  // args remain valid (none of the current commands actually use bare-`-`

  // positional, but the explicit allow-list keeps the door open if needed).

  const shortFlagAliases: Record<string, string> = {

    'p': 'prompt',

    // Add more here if PRD documents additional short flags.

  };



  let i = 0;

  while (i < args.length) {

    const arg = args[i];

    if (arg.startsWith('--')) {

      // Support both `--key value` and `--key=value` forms. The equals form

      // is ubiquitous in GNU-style CLIs; without it, callers (especially AI

      // agents) get silently-dropped values + confusing "missing flag" errors

      // downstream.

      const raw = arg.slice(2);

      const eq = raw.indexOf('=');

      const key = eq >= 0 ? raw.slice(0, eq) : raw;

      const inlineValue = eq >= 0 ? raw.slice(eq + 1) : undefined;

      // Boolean flags (no value follows). Missing entries trigger the

      // generic key-value branch below — which consumes the NEXT token as

      // value when it doesn't start with `--`. That silently eats short

      // flags like `-p` (a presence-only flag followed by `-p` would otherwise

      // swallow `-p` as its value and drop the prompt).

      // Add any new presence-only flag here.

      if (

        key === 'help' ||

        key === 'json' ||

        key === 'dry-run' ||

        key === 'disable-nonessential' ||

        key === 'full' ||

        key === 'clear-provider-override' ||

        key === 'new-dek' ||

        // 2026-08-06 审计 F-12：这些 presence-only flag 之前不在清单里，
        // `--yes-high-risk myskill` 会把 myskill 吞成 flag 值、positional 丢失。
        key === 'yes-high-risk' ||

        key === 'force' ||

        key === 'purge-data' ||

        key === 'include-deleted' ||

        key === 'run'

      ) {

        flags[camelCase(key)] = true;

        i++;

        continue;

      }

      // Repeatable flags: ALWAYS consume the next token as a value, even if it

      // starts with '--' (e.g. --args "--stdio"). The boolean-fallback check

      // below must NOT run for repeatable flags — it would overwrite the

      // accumulated array with `true`.

      if (repeatable.has(key)) {

        const cKey = camelCase(key);

        const arr = (flags[cKey] as string[]) || [];

        if (inlineValue !== undefined) {

          arr.push(inlineValue);

          flags[cKey] = arr;

          i++;

          continue;

        }

        const value = args[i + 1];

        if (value === undefined) {

          // No value — normalize to empty array (not boolean) to keep type consistent

          if (!flags[cKey]) flags[cKey] = [];

          i++;

          continue;

        }

        arr.push(value);

        flags[cKey] = arr;

        i += 2;

        continue;

      }

      // Key-value flags (non-repeatable)

      if (inlineValue !== undefined) {

        flags[camelCase(key)] = inlineValue;

        i++;

        continue;

      }

      const value = args[i + 1];

      if (value === undefined || value.startsWith('--')) {

        flags[camelCase(key)] = true;

        i++;

        continue;

      }

      flags[camelCase(key)] = value;

      i += 2;

    } else if (arg.length === 2 && arg.startsWith('-') && shortFlagAliases[arg.slice(1)]) {

      // Short flag (e.g. -p) maps to long flag (--prompt). Always consumes the

      // next token as value (or treats as boolean if next is missing/another flag).

      const longKey = shortFlagAliases[arg.slice(1)]!;

      const value = args[i + 1];

      if (value === undefined || value.startsWith('-')) {

        flags[camelCase(longKey)] = true;

        i++;

      } else {

        flags[camelCase(longKey)] = value;

        i += 2;

      }

    } else {

      positional.push(arg);

      i++;

    }

  }

  return { positional, flags };

}



/**

 * Reject flags that arrived without a value (parser fell back to `true`

 * when the next token was another `--flag`). Surfaces a clear, exit-1

 * CLI error BEFORE any HTTP call — prevents the downstream handler from

 * seeing a bool where it expected a string and returning an opaque

 * "transport/parse failed" error to the AI caller.

 */

function assertStringFlag(value: unknown, flagName: string): asserts value is string | undefined {

  if (value === true) {

    console.error(`Error: --${flagName} requires a value (e.g. --${flagName} foo or --${flagName}=foo)`);

    process.exit(2);

  }

}



function camelCase(s: string): string {

  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

}



/**

 * Demand a positional argument BEFORE issuing an API call. Issue #149: on

 * Windows some commands' positional args were getting silently dropped

 * before reaching the server, surfacing as a server-side "Missing required

 * argument" or "missing field" — which makes the AI think the CLI itself

 * is at fault. This shortcut exits at the CLI boundary with a concrete

 * usage hint so the AI's recovery path is clearer than parsing a server

 * 422.

 *

 * If `value` is non-empty, returns it (narrowed to `string`). If empty,

 * exits 1 with a `zhishi <command>` usage line for the AI to follow.

 *

 * `flagAlternative` documents the `--<flag>` form a caller can use as a

 * workaround when shell quoting drops a positional.

 */

function requirePositional(

  value: string | undefined,

  argName: string,

  command: string,

  flagAlternative?: string,

): string {

  const v = (value ?? '').trim();

  if (v) return v;

  console.error(`Error: ${command} requires <${argName}>.`);

  console.error(`  Usage: zhishi ${command} <${argName}>${flagAlternative ? ` (or --${flagAlternative} <${argName}>)` : ''}`);

  process.exit(1);

}



// ---------------------------------------------------------------------------

// Help text

// ---------------------------------------------------------------------------



const TOP_HELP = `zhishi — ZhiShi Self-Configuration CLI



Usage: zhishi <command> [options]



Commands:

  mcp       Manage MCP tool servers

  model     Manage model providers

  agent     Manage agents (+ 'agent show <id>' for effective defaults)
            会话引擎: pi(M4c 起唯一引擎,SDK 已删除);
            ZHISHI_LOOP_ENGINE/loopEngine=sdk 仅兼容读取,告警并回落 pi

  env       Named environments (list/add/remove/open) + recipes (recipes/up/down/ps) + engine probe

  skill     Manage skills (list, info, enable/disable, remove)

  domain    域包清单（list / check <域>——就绪自检：引用完整性+验收清单）

  appcraft  AppCraft workspace app automation (record/list/replay traces)

  task      Manage Task Center tasks (list/get/update-status/run/rerun ...)

  research  Research outcome signals (log/list) — security researcher edition



  term      Drive embedded terminal (open/write/read/close)

  widget    Generative UI widget design guidelines (readme)



  config    Read/write application config



  status    Show app running state

  version   Show app version

  reload    Hot-reload configuration



Global flags:

  --help      Show help for any command

  --json      Output as JSON

  --dry-run   Preview changes without applying

  --port NUM  Override Sidecar port (default: $ZHISHI_PORT)



Examples:

  zhishi mcp list

  zhishi mcp show playwright

  zhishi mcp add --id playwright --type stdio --command npx --args @playwright/mcp@latest

  zhishi mcp enable playwright --scope both

  zhishi mcp oauth discover notion-mcp

  zhishi mcp oauth start notion-mcp

  zhishi model list

  zhishi model set-key deepseek sk-xxx

  zhishi skill list

  zhishi skill remove my-skill

  zhishi appcraft list

  zhishi appcraft record start --app kingdee

  zhishi appcraft record stop

  zhishi appcraft replay monthly-report --var 月份=2026-06

  zhishi appcraft replay monthly-report --yes-high-risk   # 确认过高危步骤后放行（PRD §6.8）

  zhishi env engines                        # probe docker/hypervisors/ssh + install guidance

  zhishi env install docker|hyperv          # auto-install a missing engine (download + verify + launch / dism)

  zhishi env list                           # named environments (id/kind/target/user)

  zhishi env add --kind ssh --id dev-box --host 10.0.0.8 --user root --key-path ~/.ssh/id_ed25519

  zhishi env open dev-box                   # open env in embedded terminal (term open --cmd)

  zhishi env remove dev-box

  zhishi env recipes                        # environment recipes (valid + invalid reasons)

  zhishi env up web-recon                   # build + start a recipe container (workspace mounted)

  zhishi env up pwn-vm --vm-base "C:\\VMs\\ubuntu\\ubuntu.vmx" --user researcher

                                            # VM recipe: direct to the real VM via vmrun (D22: revert snapshot, no copy)

                                            # vm recipe frontmatter 可加 vm_engine: vmware|hyperv|virtualbox（缺省 vmware；

                                            # hyperv 模板 = Export-VM 导出目录，virtualbox 模板 = 已注册 VM 名）

  zhishi env adopt pwn-vm --vm "C:\\VMs\\ubuntu\\ubuntu.vmx"

                                            # adopt existing VM as template (auto-provision + snapshot)

  zhishi env build pwn-vm --disk-gb 60 --mem-mb 4096 --cpus 4

                                            # build VM template from scratch (unattended Ubuntu ISO install)

  zhishi env ps                             # running recipe instances (docker label / vmrun list)

  zhishi env down <container-id|env-id|vmx>   # stop + remove (docker) / stop soft (VM; VM files kept)

  zhishi env exec <env-id> -- <command...>  # isolated VM one-shot exec via vmrun guest channel (P2)

  zhishi agent                              # interactive agent session TUI (P1-T2)

  zhishi agent show <agent-id>              # effective defaults for a workspace

  zhishi task list

  zhishi task get <taskId>            # returns metadata + docs paths

                                        # (task.md / verify.md / progress.md /

                                        #  alignment.md — read/edit them with

                                        #  standard Read/Edit/Write tools)

  zhishi task update-status <taskId> running --message "starting work"

  zhishi task update-status <taskId> verifying

  zhishi task update-status <taskId> done --message "bundle size dropped 40%"

  zhishi task append-session <taskId> <sessionId>

  zhishi task run <taskId>

  zhishi task rerun <taskId>

  zhishi task create-direct --name "review PR" \\

      --workspaceId proj --workspacePath /path/to/proj \\

      --taskMdContent "Review this PR and file findings in progress.md" \\

      --model claude-sonnet-4-6

    # Per-task model override — omit to inherit the agent workspace default.

  zhishi task create-from-alignment <alignmentSessionId> --name "新任务"

    # Backend auto-inherits workspaceId / workspacePath / sourceThoughtId

    # from the alignment session's metadata (set when 「AI 讨论」 launched).

    # Pass --run to dispatch immediately in the same call.

    # Pass --json for machine-readable output (task_id + docs_path).

    # Same per-task override flags as create-direct apply here.

  zhishi memory search <关键词> [--kind kind1,kind2] [--limit N]

    # 检索长期记忆库（distill 蒸馏产物 + 主动沉淀的记忆），按需想起。

    # 返回按有效分排序的记忆条目，命中即记 recall 事件（影响后续排序）。

  zhishi research log --task-kind binary --outcome success \

      --bug-class uaf --summary "hacknote fastbin dup 拿 flag" [--trajectory-ref traj/hacknote.md]

    # 记录一条研究成败信号（安全蒸馏闭环原料）。枚举：--task-kind binary/pentest/

    # ai-security/redteam/malware/intel/ctf；--outcome success/fail/stuck。

  zhishi research list [--task-kind binary] [--outcome stuck] [--limit N]

  zhishi term open --cwd /path/to/proj --rows 40 --cols 120 [--cmd "<命令>"] [--env <tag>]

    # 打开内嵌终端（AI 驱动），返回 terminalId 供 write/read/close 使用。

    # --cmd 让终端直接运行指定命令（如 "ssh user@target"、"docker exec -it <c> bash"），

    # 缺省起默认 shell。

    # --env 打 D14 边界标记（host / docker:<c> / vm:<name> / range:<host>）；

    # env≠host 的终端后续 write/read 界内自动放行（zhishi env open 会自动带标记）。

  zhishi term list                            # 列出终端及其 env 标记

  zhishi term write <terminalId> 'ls -la'   # 批量/换行输入用 --data-file <path>

  zhishi term read <terminalId> [--cursor N]

  zhishi term close <terminalId>


  zhishi version

  zhishi reload



Run 'zhishi <command> --help' for details on a specific command.`;



// ---------------------------------------------------------------------------

// HTTP client

// ---------------------------------------------------------------------------



// adopt/build 等环境操作是分钟级长任务，全局 fetch（undici）默认
// headersTimeout 300s 会把仍在正常执行的服务端请求掐断（2026-08-15 实测：
// adopt 跑了 9 分钟，客户端 5 分钟报 HeadersTimeoutError，服务端还在跑）。
// CLI 对 admin API 一律不设 header/body 超时——慢由服务端自己的错误面表达。
// 注意必须用 undici 自己的 fetch：Node 全局 fetch 不接受自定义 dispatcher
// （报 invalid onRequestStart，2026-08-16 实测）。
const adminDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });



async function callApi(route: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {

  try {

    const resp = await undiciFetch(`${BASE}/${route}`, {

      method: 'POST',

      headers: { 'Content-Type': 'application/json' },

      body: JSON.stringify(body),

      dispatcher: adminDispatcher,

    });

    // Non-JSON error bodies (e.g. axum 4xx returns plain text like

    // "Failed to deserialize query string: missing field `doc`") would

    // crash `resp.json()` with a SyntaxError — translate to an

    // AdminResponse-shaped error so the caller can surface it cleanly.

    const contentType = resp.headers.get('content-type') ?? '';

    if (!contentType.includes('application/json')) {

      const text = await resp.text();

      return {

        success: false,

        error: text.trim() || `HTTP ${resp.status} ${resp.statusText}`,

      };

    }

    return await resp.json() as Record<string, unknown>;

  } catch (err) {

    const msg = err instanceof Error ? err.message : String(err);

    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {

      console.error('Error: Cannot connect to ZhiShi. Is the app running?');

      if (process.env.CODEX_SANDBOX || process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1') {

        console.error('  This command appears to be running inside the Codex sandbox.');

        console.error('  If ZhiShi is running on localhost, switch Codex to no-restrictions or run the command from your normal terminal.');

      }

      process.exit(3);

    }

    throw err;

  }

}



// ---------------------------------------------------------------------------

// Output formatting

// ---------------------------------------------------------------------------



function printResult(group: string, action: string, result: Record<string, unknown>, jsonMode: boolean, _flags: Record<string, unknown> = {}): void {

  if (jsonMode) {

    console.log(JSON.stringify(result, null, 2));

    return;

  }



  if (!result.success) {

    console.error(`Error: ${result.error}`);

    // Structured recovery hint (v0.1.69+): print `→ Run: <command>   <message>`

    // below the error line in human mode so a downstream AI reader has a

    // concrete next step, not just a rejection. JSON mode preserves the full

    // shape via the `JSON.stringify` branch above.

    const hint = result.recoveryHint as { recoveryCommand?: string; message?: string } | undefined;

    if (hint && typeof hint === 'object') {

      if (hint.recoveryCommand) {

        const suffix = hint.message ? `   ${hint.message}` : '';

        console.error(`  \u2192 Run: ${hint.recoveryCommand}${suffix}`);

      } else if (hint.message) {

        console.error(`  ${hint.message}`);

      }

    }

    // AppCraft replay failures carry the structured failed-step report in data

    // — surface it in human mode so the AI 自愈 flow sees step index + reason

    // + locator without re-running with --json.

    if (group === 'appcraft' && action === 'replay') {

      const data = (result.data as Record<string, unknown> | undefined) ?? {};

      const failure = data.failure as

        | { stepIndex?: number; action?: string; reason?: string; locator?: unknown; requiresAiHeal?: boolean; requiresApproval?: boolean }

        | undefined;

      if (failure && typeof failure === 'object') {

        console.error(`  failed step: #${failure.stepIndex ?? '?'} (${failure.action ?? '?'})`);

        if (failure.reason) console.error(`  reason: ${failure.reason}`);

        if (failure.locator) console.error(`  locator: ${JSON.stringify(failure.locator)}`);

        if (failure.requiresApproval) console.error('  高危步骤未批准——请用户确认后加 --yes-high-risk 重跑');

        if (failure.requiresAiHeal) console.error('  fallback: ai_vision — AI 自愈可接手重新定位该步骤');

      } else {

        const stdout = typeof data.stdout === 'string' ? data.stdout.trim() : '';

        const stderr = typeof data.stderr === 'string' ? data.stderr.trim() : '';

        if (stdout) console.error(`--- cuse output ---\n${stdout}`);

        if (stderr) console.error(`--- cuse stderr ---\n${stderr}`);

      }

    }

    return;

  }



  // Dry-run

  if (result.dryRun) {

    console.log('[DRY RUN] Would apply:');

    console.log(formatObject(result.preview as Record<string, unknown>));

    console.log('\nRun without --dry-run to apply.');

    return;

  }



  // Group-specific formatting

  if (group === 'mcp' && action === 'list') {

    printMcpList(result.data as Array<Record<string, unknown>>);

    return;

  }

  if (group === 'mcp' && action === 'show') {

    printMcpShow(result.data as Record<string, unknown>);

    return;

  }

  if (group === 'model' && action === 'list') {

    printModelList(result.data as Array<Record<string, unknown>>);

    return;

  }

  if (group === 'agent' && action === 'list') {

    printAgentList(result.data as Array<Record<string, unknown>>);

    return;

  }

  if (group === 'task' && action === 'list') {

    printTaskList(result.data as Array<Record<string, unknown>>);

    return;

  }

  if (group === 'task' && action === 'get') {

    printTaskDetail(result.data as Record<string, unknown>);

    return;

  }

  if (group === 'skill' && action === 'list') {

    printSkillList(result.data as Array<Record<string, unknown>>);

    return;

  }

  if (group === 'skill' && action === 'info') {

    printSkillInfo(result.data as Record<string, unknown>);

    return;

  }

  if (group === 'appcraft' && action === 'list') {

    printAppcraftList(result.data as Record<string, unknown> | undefined);

    return;

  }

  if (group === 'appcraft' && action === 'replay') {

    printAppcraftReplay(result);

    return;

  }

  if (group === 'appcraft' && action === 'record') {

    printAppcraftRecord(result);

    return;

  }

  if (group === 'mcp' && action === 'oauth') {

    printMcpOAuth(result.data as Record<string, unknown>);

    return;

  }

  if (group === 'version') {

    console.log((result.data as { version: string })?.version ?? 'Unknown');

    return;

  }

  if (group === 'config' && action === 'get') {

    // Issue #149: was falling through to `✓ get` (id-only generic

    // formatter). Now show the actual key + (possibly redacted) value.

    const data = (result.data as Record<string, unknown>) ?? {};

    const key = data.key ?? '';

    const value = data.value;

    if (typeof value === 'object' && value !== null) {

      console.log(`${key}:`);

      console.log(formatObject(value as Record<string, unknown>));

    } else {

      console.log(`${key}: ${value === undefined ? '(unset)' : String(value)}`);

    }

    return;

  }

  if (group === 'mcp' && action === 'env') {

    // `mcp env get/set/delete` — generic ✓ formatter swallowed values for

    // get. Render env map for any sub-action (issue #149).

    const data = (result.data as Record<string, unknown>) ?? {};

    const env = (data.env as Record<string, unknown>) ?? data;

    if (env && typeof env === 'object' && Object.keys(env).length > 0) {

      console.log(formatObject(env as Record<string, unknown>));

    } else {

      console.log('(no env vars set)');

    }

    if (result.hint) console.log(`\n${result.hint}`);

    return;

  }

  if (group === 'agent' && action === 'show') {

    printAgentShow(result.data as Record<string, unknown>);

    return;

  }

  if (group === 'env' && action === 'engines') {

    printEnvEngines(result.data as Record<string, unknown>);

    return;

  }

  if (group === 'env' && action === 'install') {

    // 引擎安装引导结果（P1 E1b）：已就绪 / 安装器路径 + 面向人的说明。
    const data = (result.data as { engine?: string; alreadyAvailable?: boolean; installerPath?: string; message?: string }) ?? {};

    if (data.alreadyAvailable) console.log(`${String(data.engine ?? '')}: 已就绪`);

    if (data.installerPath) console.log(`installer: ${String(data.installerPath)}`);

    if (data.message) console.log(String(data.message));

    return;

  }

  if (group === 'env' && action === 'list') {

    const data = (result.data as { environments?: Array<Record<string, unknown>> }) ?? {};

    printEnvList(data.environments ?? []);

    return;

  }

  if (group === 'env' && action === 'open') {

    // 与 term open 一致：terminalId 显眼打印（后续 write/read/close 要带它），

    // 附带解析出的接入命令，便于 AI 核对落点。

    const data = (result.data as Record<string, unknown>) ?? {};

    console.log(`terminalId: ${String(data.terminalId ?? '')}`);

    if (data.envTag) console.log(`envTag: ${String(data.envTag)}`);

    if (data.cmd) console.log(`command: ${String(data.cmd)}`);

    return;

  }

  if (group === 'env' && action === 'recipes') {

    const data = (result.data as { recipes?: Array<Record<string, unknown>>; root?: string }) ?? {};

    printEnvRecipes(data.recipes ?? [], data.root);

    return;

  }

  if (group === 'env' && action === 'ps') {

    const data = (result.data as { instances?: Array<Record<string, unknown>> }) ?? {};

    printEnvInstances(data.instances ?? []);

    return;

  }

  if (group === 'env' && action === 'up') {

    // 实例名/容器 id 显眼打印（env down / docker exec 要带它们）；

    // VM 实例附带 guest 地址（env open 走 SSH 的落点）。

    const data = (result.data as { instance?: Record<string, unknown> }) ?? {};

    const instance = data.instance ?? {};

    console.log(`instance: ${String(instance.name ?? '')}`);

    if (instance.id && instance.id !== instance.name) {

      console.log(`containerId: ${String(instance.id)}`);

    }

    if (instance.address) console.log(`address: ${String(instance.address)}`);

    if (instance.vmx) console.log(`vmx: ${String(instance.vmx)}`);

    if (instance.workspace) console.log(`workspace: ${String(instance.workspace)}`);

    return;

  }

  if (group === 'env' && action === 'down') {

    const data = (result.data as { removed?: string }) ?? {};

    console.log(`removed: ${String(data.removed ?? '')}`);

    return;

  }

  if (group === 'env' && action === 'rm') {

    const data = (result.data as { removed?: string }) ?? {};

    console.log(`removed: ${String(data.removed ?? '')}（VM 环境只摘登记，VM 文件不动；hyperv/vbox 派生实例已删）`);

    return;

  }

  if (group === 'env' && action === 'adopt') {

    // 模板认领成功：模板路径/用户/快照显眼打印，提示 env up 已免 --vm-base。

    const data = (result.data as { template?: Record<string, unknown>; address?: string; channel?: string }) ?? {};

    const template = data.template ?? {};

    console.log(`template: ${String(template.vmx ?? '')}`);

    console.log(`user: ${String(template.user ?? '')}`);

    console.log(`keyPath: ${String(template.keyPath ?? '')}`);

    console.log(`snapshot: ${String(template.snapshot ?? '')}`);

    if (data.address) console.log(`address: ${String(data.address)}`);

    if (data.channel) console.log(`channel: ${String(data.channel)}`);

    return;

  }

  if (group === 'env' && action === 'build') {

    // 模板构建成功（P2 V7）：模板路径/用户/快照/地址显眼打印，与 adopt 同形态。

    const data = (result.data as { template?: Record<string, unknown>; address?: string }) ?? {};

    const template = data.template ?? {};

    console.log(`template: ${String(template.vmx ?? '')}`);

    console.log(`user: ${String(template.user ?? '')}`);

    console.log(`keyPath: ${String(template.keyPath ?? '')}`);

    console.log(`snapshot: ${String(template.snapshot ?? '')}`);

    if (data.address) console.log(`address: ${String(data.address)}`);

    return;

  }

  if (group === 'env' && action === 'exec') {

    // guest-exec（P2 B2）：stdout 原样输出（可被管道/AI 消费）；guest 命令

    // 非零退出不算通道失败（上方错误分支已截），打到 stderr 并把 CLI 退出码

    // 置 1（走自然退出，process.exitCode 生效）。

    const data = (result.data as { stdout?: string; exitCode?: number }) ?? {};

    const stdout = typeof data.stdout === 'string' ? data.stdout : '';

    if (stdout) process.stdout.write(stdout.endsWith('\n') ? stdout : `${stdout}\n`);

    const exitCode = typeof data.exitCode === 'number' ? data.exitCode : 0;

    if (exitCode !== 0) {

      console.error(`guest 命令退出码: ${exitCode}`);

      process.exitCode = 1;

    }

    return;

  }

  if (group === 'status') {

    printStatus(result.data as Record<string, unknown>);

    return;

  }

  if (group === 'help') {

    console.log((result.data as { text: string })?.text ?? '');

    return;

  }



  // Tool readmes: any `widget ...` form returns a raw text body in
  // result.data.text. Print it as-is — no padding,

  // no status line, no ticks — so AI can consume it directly as context.

  if (action === 'readme' || group === 'widget') {

    console.log((result.data as { text: string })?.text ?? '');

    return;

  }



  // Task create-* — AI-facing flow: print task_id + docs path + next-step

  // hint + any override echo so the caller doesn't have to guess the id via

  // `ls -lt ~/.zhishi/tasks/`. JSON mode above returns the full payload.

  // Both `create-direct` and `create-from-alignment` go through the same

  // `enrichTaskCreateResponse` server-side, so one printer covers both.

  if (group === 'task' && (action === 'create-direct' || action === 'create-from-alignment')) {

    printTaskCreateResult(result.data as Record<string, unknown>);

    return;

  }



  // Task run — print the engine/model the task will execute on, plus the

  // task_id echo so the caller has observability on what was dispatched.

  if (group === 'task' && (action === 'run' || action === 'rerun')) {

    printTaskDispatchResult(action, result.data as Record<string, unknown>);

    return;

  }



  // Memory search：agent 是主要读者——每条记忆一行，内容先行，评分随行
  // （它需要内容来引用，需要 id/分值来判断置信度）。空结果也要明说，
  // 否则 agent 会把静默当成命令失败。

  if (group === 'memory' && action === 'search') {

    const results = (((result.data as Record<string, unknown>)?.results) ?? []) as Array<Record<string, unknown>>;

    if (results.length === 0) {

      console.log('（无命中记忆）');

      return;

    }

    for (const r of results) {

      const date = typeof r.lastTouchedAt === 'number' ? new Date(r.lastTouchedAt).toISOString().slice(0, 10) : '?';

      const source = typeof r.source === 'string' && r.source ? `（来源：${r.source}）` : '';

      console.log(`- [${String(r.kind)}] ${String(r.content)}${source}  <id=${String(r.id)} | 触于 ${date} | salience ${String(r.salience)} | usefulness ${String(r.usefulness)}>`);

    }

    return;

  }



  // Domain（域包清单层 P2）：list 一域一行;check 列引用问题+验收清单。
  if (group === 'domain') {
    const data = (result.data as Record<string, unknown>) ?? {};
    if (action === 'list') {
      const domains = (Array.isArray(data.domains) ? data.domains : []) as Array<Record<string, unknown>>;
      if (domains.length === 0) {
        console.log('（无域包——bundled-domains/<域>/domain.json 新建）');
        return;
      }
      for (const d of domains) {
        const recipes = Array.isArray(d.recipes) ? (d.recipes as string[]).join(',') : '';
        const skills = Array.isArray(d.skills) ? (d.skills as string[]).join(',') : '';
        console.log(`- ${String(d.kind)}（${String(d.name)}）  类型:${recipes || '无'}  skills:${skills || '无'}  信号:${String(d.signalCount ?? 0)} 条`);
      }
      return;
    }
    if (action === 'check') {
      const one = data.kind ? data : undefined; // 单域形态
      const domains = one
        ? [one]
        : (Array.isArray(data.domains) ? (data.domains as Array<Record<string, unknown>>) : []);
      for (const d of domains) {
        const ok = d.ok === true;
        console.log(`${ok ? '✓' : '✗'} ${String(d.kind)}（${String(d.name)}）`);
        const issues = Array.isArray(d.issues) ? (d.issues as Array<Record<string, unknown>>) : [];
        for (const i of issues) {
          console.log(`    ${i.level === 'error' ? '✗' : '⚠'} ${String(i.message)}`);
        }
        const acc = Array.isArray(d.acceptance) ? (d.acceptance as string[]) : [];
        if (acc.length) {
          console.log('    验收清单:');
          for (const a of acc) console.log(`      · ${a}`);
        }
      }
      return;
    }
  }

  // Research（安全研究员版 P1 D1）——agent 是主要读者：log 打一行确认
  // （带事件 id），list 一行一个事件（taskKind/outcome/bugClass + summary + 轨迹指针）。

  if (group === 'research') {

    const data = (result.data as Record<string, unknown>) ?? {};

    if (action === 'log') {

      const ev = (data.event ?? {}) as Record<string, unknown>;

      console.log(`✓ 已记录研究事件 #${String(ev.id ?? '?')}（${String(ev.taskKind ?? '')} / ${String(ev.outcome ?? '')}）`);

      return;

    }

    if (action === 'list') {

      const results = (Array.isArray(data.results) ? data.results : []) as Array<Record<string, unknown>>;

      if (results.length === 0) {

        console.log('（无研究事件）');

        return;

      }

      for (const r of results) {

        const date = typeof r.ts === 'number' ? new Date(r.ts).toISOString().slice(0, 10) : '?';

        const bug = typeof r.bugClass === 'string' && r.bugClass ? ` [${r.bugClass}]` : '';

        const traj = typeof r.trajectoryRef === 'string' && r.trajectoryRef ? `  轨迹：${r.trajectoryRef}` : '';

        console.log(`- [${String(r.taskKind)}/${String(r.outcome)}]${bug} ${String(r.summary)}${traj}  <#${String(r.id)} | ${date}>`);

      }

      return;

    }

  }



  // term（AI 驱动内嵌终端）——AI 是主要读者：open 把 id 显眼

  // 打印（后续每条命令都要带它）；read 原样输出内容、不加任何装饰，

  // 因为那就是给 AI 看的终端输出。write/close 落到通用 ✓ 确认。

  if (group === 'term') {

    const data = (result.data as Record<string, unknown>) ?? {};

    if (action === 'open') {

      console.log(`terminalId: ${String(data.terminalId ?? '')}`);

      if (typeof data.envTag === 'string' && data.envTag) console.log(`envTag: ${data.envTag}`);

      return;

    }

    if (action === 'list') {

      // AI 是主要读者：一行一个终端，envTag 缺省视为 host（D14 边界标记）。

      const terminals = Array.isArray(data.terminals) ? data.terminals : [];

      for (const t of terminals) {

        const term = t as Record<string, unknown>;

        console.log(`${String(term.terminalId ?? '')}  env=${String(term.envTag ?? 'host')}`);

      }

      return;

    }

    if (action === 'read') {

      if (typeof data.text === 'string') process.stdout.write(data.text);

      if (data.closed) console.error('[term] terminal already closed — 该终端已退出，请勿再 write');

      return;

    }

  }

  // Generic success output

  const symbol = '\u2713'; // ✓

  const hint = result.hint ? ` ${result.hint}` : '';

  const id = (result.data as Record<string, unknown>)?.id ?? '';

  console.log(`${symbol} ${action} ${id}${hint}`);

}



/**

 * Format output for `task create-from-alignment` (and eventually `task create-direct`).

 *

 * AI scripts need at minimum the `task_id` of the newly minted task so they

 * can call `task run <id>` next. Also surfaces `docs_path` because the AI

 * often wants to tell the human "I wrote the task docs to X" and having

 * that string in the CLI output saves a re-lookup.

 *

 * Plaintext shape deliberately mirrors what `--json` produces so readers

 * can mentally switch between the two without re-learning fields:

 *

 *   ✓ Task created

 *     task_id:   <uuid>

 *     name:      <string>

 *     docs_path: ~/.zhishi/tasks/<uuid>/

 *     next:      zhishi task run <uuid>

 */

function printTaskCreateResult(data: Record<string, unknown>): void {

  // Handler returns { task, dispatched?, runResult? } — `task` is the full

  // Task record; `dispatched/runResult` appear when the caller passed --run.

  const task = (data?.task as Record<string, unknown>) ?? data;

  const id = String(task?.id ?? '');

  const name = String(task?.name ?? '');

  const dataDir = getZhiShiDataDir();

  const absDocs = `${dataDir}/tasks/${id}/`;

  const home = homedir();

  const displayDocs = absDocs.startsWith(home)

    ? `~${absDocs.slice(home.length)}`

    : absDocs;



  console.log('\u2713 Task created');

  if (id) console.log(`  task_id:   ${id}`);

  if (name) console.log(`  name:      ${name}`);

  console.log(`  docs_path: ${displayDocs}`);



  // Surface which model override actually landed on the

  // persisted task (read from the server-returned Task record, not echoed

  // from the request). Visible here — not buried in --json — because the AI

  // needs to confirm "the override I specified stuck" before dispatching.

  // A mismatch between `overridesRequested` and `overridden` indicates the

  // server silently dropped a field, which the AI should flag to the user.

  const overridden = (data?.overridden as string[] | undefined) ?? [];

  const overridesRequested = (data?.overridesRequested as string[] | undefined) ?? [];

  const overrides = (data?.overrides as Record<string, unknown> | undefined) ?? {};

  if (overridden.length > 0) {

    console.log(`  overrides: ${overridden.join(', ')}`);

    for (const field of overridden) {

      const v = overrides[field];

      if (v !== null && v !== undefined && v !== '') {

        const display = typeof v === 'object' ? JSON.stringify(v) : String(v);

        console.log(`    ${field.padEnd(14)} = ${display}`);

      }

    }

  } else {

    console.log('  overrides: (none — inherits workspace defaults)');

  }

  // Drift warning: requested override didn't reach the persisted task.

  const droppedFields = overridesRequested.filter(f => !overridden.includes(f));

  if (droppedFields.length > 0) {

    console.log('');

    console.log(`  \u26A0 warning: requested overrides were NOT persisted: ${droppedFields.join(', ')}`);

    console.log('    This likely indicates a server-side deserialization gap — please report.');

  }



  const nextSteps = data?.nextSteps as Record<string, string> | undefined;

  const dispatch = nextSteps?.dispatch ?? (id ? `zhishi task run ${id}` : '');

  if (dispatch) console.log(`  next:      ${dispatch}`);



  // If --run was bundled with create, the backend also dispatched; echo

  // the dispatch summary inline so the caller sees both in one output.

  const runResult = data?.runResult as Record<string, unknown> | undefined;

  if (runResult) {

    console.log('');

    printTaskDispatchResult('run', runResult);

  }

}



/**

 * Format `zhishi env engines` output (P1 E1): one line per engine

 * (✓ + version / ✗ + install guidance) plus the aggregate has* summary.

 */

function printEnvEngines(data: Record<string, unknown>): void {

  const engines = (data.engines as Array<Record<string, unknown>> | undefined) ?? [];

  for (const engine of engines) {

    const mark = engine.available ? '✓' : '✗';

    const version = engine.version ? `  ${String(engine.version)}` : '';

    console.log(`${mark} ${String(engine.kind)}${version}`);

    if (!engine.available && engine.guidance) {

      console.log(`    → ${String(engine.guidance)}`);

    } else if (engine.available && engine.detail) {

      console.log(`    ${String(engine.detail)}`);

    }

  }

  console.log('');

  const yn = (v: unknown) => (v ? 'yes' : 'no');

  console.log(

    `container engine: ${yn(data.hasContainerEngine)}   hypervisor: ${yn(data.hasHypervisor)}   ssh: ${yn(data.hasSsh)}`,

  );

}



/**

 * Format `zhishi env list` output (P1 E3): one row per named environment —

 * id / kind / 接入目标 / user。target 按 kind 取：ssh→host、docker→container、

 * vm→vmName（有 address 时附上）。

 */

function printEnvList(environments: Array<Record<string, unknown>>): void {

  const pad = (s: string, n: number) => s.padEnd(n);

  if (environments.length === 0) {

    console.log('(no environments — add one: zhishi env add --kind ssh --id <id> --host <host>)');

    return;

  }

  console.log(pad('ID', 18) + pad('KIND', 9) + pad('TARGET', 30) + 'USER');

  for (const env of environments) {

    const kind = String(env.kind ?? '');

    const target = kind === 'vm'

      ? `${String(env.vmName ?? '')}${env.address ? ` (${String(env.address)})` : ''}`

      : String(env.host ?? env.container ?? '');

    console.log(

      pad(String(env.id ?? ''), 18) + pad(kind, 9) + pad(target, 30) + String(env.user ?? ''),

    );

  }

}



/**

 * Format `zhishi env recipes` output (P1 E4): one row per recipe —

 * id / base / 状态（✓ valid / ✗ + invalid 原因）/ 工具清单。

 */

function printEnvRecipes(recipes: Array<Record<string, unknown>>, root?: string): void {

  const pad = (s: string, n: number) => s.padEnd(n);

  if (recipes.length === 0) {

    console.log(`(no environment recipes${root ? ` under ${root}` : ''} — 环境类型随 bundled-environments 播种)`);

    return;

  }

  console.log(pad('ID', 18) + pad('BASE', 8) + pad('OK', 4) + 'TOOLS');

  for (const recipe of recipes) {

    const tools = Array.isArray(recipe.tools) ? (recipe.tools as string[]).join(', ') : '';

    console.log(

      pad(String(recipe.id ?? ''), 18) + pad(String(recipe.base ?? '?'), 8) + pad(recipe.valid ? '✓' : '✗', 4) + tools,

    );

    if (!recipe.valid && Array.isArray(recipe.invalidReasons)) {

      for (const reason of recipe.invalidReasons as string[]) {

        console.log(`    → ${reason}`);

      }

    }

  }

}



/**

 * Format `zhishi env ps` output (P1 E4): one row per running instance —

 * 容器短 id / 实例名 / 配方 / workspace / status。

 */

function printEnvInstances(instances: Array<Record<string, unknown>>): void {

  const pad = (s: string, n: number) => s.padEnd(n);

  if (instances.length === 0) {

    console.log('(no running environment instances — start one: zhishi env up <recipe>)');

    return;

  }

  console.log(pad('ID', 15) + pad('NAME', 30) + pad('DRIVER', 8) + pad('RECIPE', 16) + pad('STATUS', 18) + 'WORKSPACE');

  for (const inst of instances) {

    console.log(

      pad(String(inst.id ?? ''), 15)

      + pad(String(inst.name ?? ''), 30)

      + pad(String(inst.driver ?? 'docker'), 8)

      + pad(String(inst.recipe ?? ''), 16)

      + pad(String(inst.status ?? ''), 18)

      + String(inst.workspace ?? ''),

    );

  }

}



/**

 * Format `zhishi agent show <id>` output.

 *

 * Exposes the resolved defaults an AI would need to decide whether a task

 * override is meaningful or a no-op. Keys are printed one-per-line with

 * `(inherits provider / workspace default)` for null/empty values so the

 * reader doesn't have to guess what an absent field means.

 */

function printAgentShow(data: Record<string, unknown>): void {

  if (!data) {

    console.log('No agent data.');

    return;

  }

  console.log(`Agent:       ${String(data.name ?? '')}`);

  console.log(`  id:        ${String(data.id ?? '')}`);

  console.log(`  enabled:   ${data.enabled ? 'yes' : 'no'}`);

  if (data.workspacePath) console.log(`  workspace: ${String(data.workspacePath)}`);

  const channelCount = data.channelCount;

  if (typeof channelCount === 'number') console.log(`  channels:  ${channelCount}`);

  console.log('');

  console.log('Effective defaults:');

  const defaults = (data.effectiveDefaults as Record<string, unknown>) ?? {};

  const fmt = (v: unknown): string => {

    if (v === null || v === undefined || v === '') return '(inherits default)';

    if (typeof v === 'object') return JSON.stringify(v);

    return String(v);

  };

  console.log(`  runtime:        ${fmt(defaults.runtime)}`);

  console.log(`  model:          ${fmt(defaults.model)}`);

  console.log(`  permissionMode: ${fmt(defaults.permissionMode)}`);

  console.log(`  providerId:     ${fmt(defaults.providerId)}`);

  if (defaults.runtimeConfig) {

    console.log(`  runtimeConfig:  ${JSON.stringify(defaults.runtimeConfig)}`);

  }

  console.log('');

}



/**

 * Format output for `task run` / `task rerun`.

 *

 * Answers the "what will this actually run on?" question so the AI caller

 * can relay engine/model back to the human in chat. `runtime` and `model`

 * are read from the updated Task record — both can be null/undefined

 * (meaning "use agent default" / "use provider default"); we explicitly

 * label that case rather than hiding it.

 */

function printTaskDispatchResult(

  action: string,

  data: Record<string, unknown>,

): void {

  const task = (data?.task as Record<string, unknown>) ?? data;

  const id = String(task?.id ?? '');

  const runtime = (task?.runtime as string) || 'builtin';

  const model = (task?.model as string) || '(agent default)';



  console.log(`\u2713 Task ${action === 'rerun' ? 'redispatched' : 'dispatched'}`);

  if (id) console.log(`  task_id:  ${id}`);

  console.log(`  runtime:  ${runtime}`);

  console.log(`  model:    ${model}`);

}



function printMcpList(servers: Array<Record<string, unknown>>): void {

  if (!servers || servers.length === 0) {

    console.log('No MCP servers configured.');

    return;

  }

  const pad = (s: string, n: number) => s.padEnd(n);

  console.log(pad('ID', 24) + pad('Type', 8) + pad('Status', 10) + 'Name');

  for (const s of servers) {

    const status = s.enabled ? 'enabled' : 'disabled';

    const builtin = s.isBuiltin ? ' (built-in)' : '';

    console.log(pad(String(s.id), 24) + pad(String(s.type), 8) + pad(status, 10) + String(s.name) + builtin);

  }

  const enabled = servers.filter(s => s.enabled).length;

  console.log(`\n${servers.length} MCP servers (${enabled} enabled)`);

}



/**

 * Format `zhishi mcp show <id>` output.

 *

 * Parallels printAgentShow — prints the user-visible config + enable state

 * (global / per-project) for a single server. Env and headers are rendered

 * as `key = <redacted>` lines when values exist; AI callers can read the

 * structure without ever seeing a secret.

 */

function printMcpShow(data: Record<string, unknown>): void {

  if (!data) {

    console.log('No MCP data.');

    return;

  }

  console.log(`MCP Server:   ${String(data.name ?? '')}`);

  console.log(`  id:         ${String(data.id ?? '')}`);

  console.log(`  type:       ${String(data.type ?? '')}`);

  if (data.description) console.log(`  description:${String(data.description)}`);

  console.log(`  built-in:   ${data.isBuiltin ? 'yes' : 'no'}`);



  const enabled = (data.enabled as { global?: boolean; project?: boolean | null }) ?? {};

  const globalState = enabled.global ? 'enabled' : 'disabled';

  const projectState = enabled.project === null || enabled.project === undefined

    ? '(no active workspace)'

    : enabled.project

      ? 'enabled'

      : 'disabled';

  console.log('');

  console.log('Enable state:');

  console.log(`  global:     ${globalState}`);

  console.log(`  project:    ${projectState}`);

  if (data.workspacePath) console.log(`  workspace:  ${String(data.workspacePath)}`);



  console.log('');

  console.log('Transport:');

  if (data.command) console.log(`  command:    ${String(data.command)}`);

  if (Array.isArray(data.args) && (data.args as unknown[]).length > 0) {

    console.log(`  args:       ${(data.args as unknown[]).map(String).join(' ')}`);

  }

  if (data.url) console.log(`  url:        ${String(data.url)}`);



  const env = data.env as Record<string, string> | undefined;

  if (env && Object.keys(env).length > 0) {

    console.log('');

    console.log('Env (values redacted):');

    for (const [k, v] of Object.entries(env)) {

      console.log(`  ${k} = ${v}`);

    }

  }

  const headers = data.headers as Record<string, string> | undefined;

  if (headers && Object.keys(headers).length > 0) {

    console.log('');

    console.log('Headers (values redacted):');

    for (const [k, v] of Object.entries(headers)) {

      console.log(`  ${k} = ${v}`);

    }

  }



  if (data.requiresConfig) {

    console.log('');

    console.log('Note: this server requires configuration before it can be enabled.');

    if (data.websiteUrl) console.log(`  See: ${String(data.websiteUrl)}`);

  }

}



function printModelList(providers: Array<Record<string, unknown>>): void {

  if (!providers || providers.length === 0) {

    console.log('No model providers configured.');

    return;

  }

  const pad = (s: string, n: number) => s.padEnd(n);

  console.log(pad('ID', 24) + pad('Status', 12) + 'Name');

  for (const p of providers) {

    // Disabled providers retain their verify status but the disabled label

    // overrides — they can't be used until re-enabled in Settings.

    const status = p.enabled === false ? 'disabled' : String(p.status);

    console.log(pad(String(p.id), 24) + pad(status, 12) + String(p.name));

  }

}



function printAgentList(agents: Array<Record<string, unknown>>): void {

  if (!agents || agents.length === 0) {

    console.log('No agents configured.');

    return;

  }

  const pad = (s: string, n: number) => s.padEnd(n);

  console.log(pad('ID', 38) + pad('Status', 10) + pad('Channels', 10) + 'Name');

  for (const a of agents) {

    const status = a.enabled ? 'enabled' : 'disabled';

    console.log(pad(String(a.id).slice(0, 36), 38) + pad(status, 10) + pad(String(a.channelCount), 10) + String(a.name));

  }

}



function printStatus(data: Record<string, unknown>): void {

  const mcp = data.mcpServers as Record<string, number>;

  console.log(`MCP Servers: ${mcp?.total ?? 0} total, ${mcp?.enabled ?? 0} enabled`);

  console.log(`Active MCP in session: ${data.activeMcpInSession}`);

  console.log(`Default provider: ${data.defaultProvider}`);

  console.log(`Agents: ${data.agents}`);

}



function printSkillList(skills: Array<Record<string, unknown>>): void {

  if (!skills || skills.length === 0) {

    console.log('No skills installed.');

    return;

  }

  const pad = (s: string, n: number) => s.padEnd(n);

  console.log(pad('Folder', 28) + pad('Scope', 10) + pad('Enabled', 10) + 'Description');

  for (const s of skills) {

    const enabled = s.enabled === false ? 'off' : 'on';

    const desc = String(s.description ?? '').slice(0, 60);

    console.log(

      pad(String(s.folderName ?? s.name ?? '?').slice(0, 26), 28) +

      pad(String(s.scope ?? 'user'), 10) +

      pad(enabled, 10) +

      desc,

    );

  }

  console.log(`\n${skills.length} skill(s)`);

}



function printSkillInfo(data: Record<string, unknown>): void {

  if (!data) {

    console.log('Skill not found.');

    return;

  }

  const fm = (data.frontmatter as Record<string, unknown>) || {};

  console.log(`Name:        ${fm.name ?? data.name ?? '?'}`);

  console.log(`Folder:      ${data.folderName ?? '?'}`);

  console.log(`Scope:       ${data.scope ?? 'user'}`);

  console.log(`Description: ${fm.description ?? ''}`);

  if (fm.author) console.log(`Author:      ${fm.author}`);

  if (fm['allowed-tools']) console.log(`Allowed:     ${JSON.stringify(fm['allowed-tools'])}`);

  console.log(`Path:        ${data.path ?? ''}`);

}



function printAppcraftList(data: Record<string, unknown> | undefined): void {

  const recordings = (data?.recordings as Array<Record<string, unknown>> | undefined) ?? [];

  const skills = (data?.skills as Array<Record<string, unknown>> | undefined) ?? [];

  const pad = (s: string, n: number) => s.padEnd(n);

  console.log(`Workspace: ${String(data?.workspacePath ?? '(unknown)')}`);

  console.log('');

  console.log(pad('Name', 30) + pad('App', 16) + pad('Steps', 8) + 'Recorded at');

  let total = 0;

  for (const s of skills) {

    total++;

    console.log(

      pad(String(s.id ?? '?').slice(0, 28), 30) +

      pad(String(s.app ?? '?').slice(0, 14), 16) +

      pad(String(s.stepCount ?? '?'), 8) +

      String(s.recordedAt ?? ''),

    );

  }

  for (const r of recordings) {

    total++;

    console.log(

      pad(`[rec] ${String(r.id ?? '?')}`.slice(0, 28), 30) +

      pad(String(r.app ?? '?').slice(0, 14), 16) +

      pad(String(r.stepCount ?? '?'), 8) +

      String(r.recordedAt ?? ''),

    );

  }

  if (total === 0) {

    console.log('(none — no .appcraft/ recordings or automation skills with trace.json)');

  }

  console.log(`\n${skills.length} skill(s), ${recordings.length} recording(s)`);

  console.log('Replay: zhishi appcraft replay <name> [--var k=v ...]');

}



function printAppcraftRecord(result: Record<string, unknown>): void {

  const data = (result.data as Record<string, unknown> | undefined) ?? {};

  // stop → { recordingId, tracePath, stepCount }

  if (typeof data.tracePath === 'string') {

    console.log(`✓ Recording saved: ${String(data.recordingId ?? '')}`);

    console.log(`  trace: ${data.tracePath}`);

    console.log(`  steps: ${String(data.stepCount ?? '?')}`);

    console.log('Next: zhishi appcraft list / replay it, or ask the agent to 沉淀成 skill');

    return;

  }

  // status → { recording, recordingId?, appId?, stepCount? }

  if (typeof data.recording === 'boolean') {

    if (data.recording) {

      console.log(`Recording in progress: ${String(data.recordingId ?? '')} (app=${String(data.appId ?? '?')}, steps so far=${String(data.stepCount ?? 0)})`);

    } else {

      console.log('Not recording. Start: zhishi appcraft record start --app <appId>');

    }

    return;

  }

  // start → { recordingId, appId, workspacePath }

  console.log(`✓ Recording started: ${String(data.recordingId ?? '')} (app=${String(data.appId ?? '?')})`);

  console.log('  Operate the app now; then: zhishi appcraft record stop');

}



function printAppcraftReplay(result: Record<string, unknown>): void {

  const data = (result.data as Record<string, unknown> | undefined) ?? {};

  console.log(`\u2713 Replay succeeded: ${String(data.id ?? '')} (app=${String(data.app ?? '?')}, steps=${String(data.stepCount ?? '?')})`);

  console.log(`  trace: ${String(data.tracePath ?? '')}`);

  const stdout = typeof data.stdout === 'string' ? data.stdout.trim() : '';

  if (stdout) {

    console.log('--- cuse output ---');

    console.log(stdout);

  }

  const stderr = typeof data.stderr === 'string' ? data.stderr.trim() : '';

  if (stderr) {

    console.log('--- cuse stderr ---');

    console.log(stderr);

  }

}



function printTaskList(tasks: Array<Record<string, unknown>>): void {

  if (!tasks || tasks.length === 0) {

    console.log('(no tasks)');

    return;

  }

  console.log(`Tasks (${tasks.length}):`);

  for (const t of tasks) {

    const status = String(t.status ?? '?');

    const mode = String(t.executionMode ?? 'once');

    const origin = String(t.dispatchOrigin ?? 'direct');

    console.log(`  ${t.id}  [${status}]  ${t.name}`);

    console.log(

      `     mode=${mode}  origin=${origin}  workspace=${t.workspaceId}  sessions=${

        Array.isArray(t.sessionIds) ? (t.sessionIds as string[]).length : 0

      }`,

    );

  }

}



function printTaskDetail(task: Record<string, unknown>): void {

  if (!task) {

    console.log('(task not found)');

    return;

  }



  // Identity + top-line state

  console.log(`Task: ${task.name ?? '(unnamed)'}`);

  console.log(`  ID:             ${task.id}`);

  const statusLine = String(task.status ?? '?');

  const updatedAt = typeof task.updatedAt === 'number' ? new Date(task.updatedAt).toISOString() : undefined;

  console.log(`  Status:         ${statusLine}${updatedAt ? ` (updated ${updatedAt})` : ''}`);

  console.log(`  Executor:       ${task.executor ?? '?'}`);

  console.log(`  Execution mode: ${task.executionMode ?? '?'}`);

  console.log(`  Dispatch:       ${task.dispatchOrigin ?? '?'}`);

  if (task.workspacePath || task.workspaceId) {

    console.log(`  Workspace:      ${task.workspacePath ?? task.workspaceId}`);

  }

  if (task.description) console.log(`  Description:    ${task.description}`);

  if (task.runMode) console.log(`  Run mode:       ${task.runMode}`);

  if (task.runtime) console.log(`  Runtime:        ${task.runtime}`);

  if (task.model) console.log(`  Model override: ${task.model}`);

  if (task.permissionMode) console.log(`  Permission:     ${task.permissionMode}`);

  if (Array.isArray(task.tags) && (task.tags as string[]).length > 0) {

    console.log(`  Tags:           ${(task.tags as string[]).join(', ')}`);

  }



  // Docs paths — the highlight of `task get`. AI consumers read these

  // files with standard Read/Edit/Write tools; there are no separate

  // `show-doc` / `write-doc` CLIs (removed v0.1.69+).

  const docs = task.docs as Record<string, string | undefined> | undefined;

  if (docs) {

    console.log('\nDocs (read/edit/write these directly — they are YOUR workspace):');

    if (docs.dir) console.log(`  Dir:            ${docs.dir}`);

    if (docs.taskMd) console.log(`  task.md:        ${docs.taskMd}`);

    if (docs.verifyMd) console.log(`  verify.md:      ${docs.verifyMd}`);

    if (docs.progressMd) console.log(`  progress.md:    ${docs.progressMd}`);

    if (docs.alignmentMd) console.log(`  alignment.md:   ${docs.alignmentMd}`);

  }



  // Schedule — only for scheduled / recurring / loop tasks

  const mode = String(task.executionMode ?? 'once');

  if (mode !== 'once') {

    console.log('\nSchedule:');

    if (task.cronExpression) {

      console.log(

        `  Cron:           ${task.cronExpression}${task.cronTimezone ? ` (${task.cronTimezone})` : ''}`,

      );

    } else if (task.intervalMinutes) {

      console.log(`  Interval:       every ${task.intervalMinutes} minute(s)`);

    } else if (task.dispatchAt) {

      const when = typeof task.dispatchAt === 'number' ? new Date(task.dispatchAt).toISOString() : String(task.dispatchAt);

      console.log(`  Dispatch at:    ${when}`);

    }

    if (task.lastExecutedAt) {

      const last = typeof task.lastExecutedAt === 'number' ? new Date(task.lastExecutedAt).toISOString() : String(task.lastExecutedAt);

      console.log(`  Last executed:  ${last}`);

    }

  }



  // End conditions — when present, they're decision-relevant

  const end = task.endConditions as Record<string, unknown> | undefined;

  if (end && (end.deadline || end.maxExecutions || end.aiCanExit === false)) {

    console.log('\nEnd conditions:');

    if (end.deadline) {

      const dl = typeof end.deadline === 'number' ? new Date(end.deadline).toISOString() : String(end.deadline);

      console.log(`  Deadline:       ${dl}`);

    }

    if (end.maxExecutions) console.log(`  Max executions: ${end.maxExecutions}`);

    if (end.aiCanExit === false) console.log(`  AI can exit:    no (must run to end conditions)`);

  }



  // Sessions

  const sessionIds = Array.isArray(task.sessionIds) ? (task.sessionIds as string[]) : [];

  if (sessionIds.length > 0) {

    console.log(`\nSessions:         ${sessionIds.join(', ')} (${sessionIds.length} total)`);

  }



  // Recent status changes — last 5, with counter

  const hist = task.statusHistory as Array<Record<string, unknown>> | undefined;

  if (hist && hist.length > 0) {

    const last5 = hist.slice(-5);

    console.log(`\nRecent changes (${last5.length} of ${hist.length}):`);

    for (const h of last5) {

      const at = typeof h.at === 'number' ? new Date(h.at).toISOString() : String(h.at ?? '');

      const actor = String(h.actor ?? '?');

      const source = h.source ? `/${h.source}` : '';

      const from = h.from ?? '—';

      const msg = h.message ? `   "${h.message}"` : '';

      console.log(`  ${at}  ${actor}${source}  ${from} → ${h.to}${msg}`);

    }

  }



  // Footer — next-step hints so the AI / user doesn't have to guess

  console.log('\nNext steps:');

  console.log('  zhishi task update-status <id> <status> [--message ...]  # transition state machine');

  console.log('  zhishi task run <id>                                     # dispatch immediately');

  console.log('  zhishi task rerun <id>                                   # re-arm stopped/blocked task');

  console.log('  zhishi task --help                                       # full Task CLI reference');

}



function printMcpOAuth(data: Record<string, unknown>): void {

  if (!data) return;

  const id = data.id ?? '';



  // discover result

  if (data.required !== undefined) {

    console.log(`MCP: ${id}`);

    console.log(`OAuth required: ${data.required ? 'yes' : 'no'}`);

    if (data.supportsDynamicRegistration) console.log('Dynamic registration: supported (zero-config)');

    if (data.scopes) console.log(`Scopes: ${(data.scopes as string[]).join(', ')}`);

    return;

  }



  // status result

  if (data.status !== undefined) {

    const symbol = data.status === 'connected' ? '\u2713' : data.status === 'expired' ? '\u26A0' : '\u2717';

    console.log(`${symbol} ${id}: ${data.status}`);

    if (data.expiresAt) console.log(`  Expires: ${new Date(Number(data.expiresAt)).toLocaleString()}`);

    if (data.scope) console.log(`  Scope: ${data.scope}`);

    return;

  }



  // start result (authUrl present)

  if (data.authUrl) {

    console.log(`OAuth authorization URL:\n  ${data.authUrl}`);

    return;

  }



  // Generic fallback (revoke, etc.)

  console.log(`\u2713 ${id}: done`);

}



function formatObject(obj: Record<string, unknown> | undefined, indent = '  '): string {

  if (!obj) return `${indent}(empty)`;

  return Object.entries(obj)

    .filter(([, v]) => v !== undefined && v !== null)

    .map(([k, v]) => {

      if (Array.isArray(v)) return `${indent}${k}: ${v.join(' ')}`;

      if (typeof v === 'object') return `${indent}${k}: ${JSON.stringify(v)}`;

      return `${indent}${k}: ${v}`;

    })

    .join('\n');

}



// ---------------------------------------------------------------------------

// Command routing

// ---------------------------------------------------------------------------





async function main(): Promise<void> {

  // `env exec <id> -- <cmd...>`（P2 B2 guest-exec）：`--` 之后的一切原样透传

  // 为 guest 命令。parseArgs 不识别 `--` 分隔符（会把首个命令词吞成空名

  // flag 的值），所以在解析前切出；只作用于 env exec，不影响其他命令。

  const isEnvExec = rawArgs[0] === 'env' && rawArgs[1] === 'exec';

  const dashDash = isEnvExec ? rawArgs.indexOf('--') : -1;

  const passthroughArgs = dashDash >= 0 ? rawArgs.slice(dashDash + 1) : [];

  const { positional, flags } = parseArgs(dashDash >= 0 ? rawArgs.slice(0, dashDash) : rawArgs);

  const jsonMode = !!flags.json;



  // Top-level help (no args, or bare --help)

  if (positional.length === 0) {

    console.log(TOP_HELP);

    return;

  }



  // Resolve port: --port flag overrides env

  PORT = (flags.port as string) || PORT;

  if (!PORT) {

    console.error('Error: ZHISHI_PORT not set. This CLI runs within the ZhiShi app.');

    process.exit(3);

  }

  BASE = `http://127.0.0.1:${PORT}/api/admin`;



  // P1-T2: bare `zhishi agent` enters the interactive session TUI (Screen/

  // LineEditor + sidecar session REST/SSE, src/cli/tui/agent.ts). Subcommands

  // (`agent list/show/enable/...`) still route to the Admin API below. Placed

  // AFTER the port check — the TUI talks to the sidecar root, so ZHISHI_PORT

  // is required (the T1 `--demo-tui` harness was removed with this entry;

  // the real loop IS the smoke test now). Non-TTY environments print a hint

  // and return cleanly inside runAgentLoop.

  if (positional[0] === 'agent' && positional.length === 1 && !flags.help) {

    // P1-T4（D17）: --env <id> / --new-env <recipe> 跳过首屏选择器直通对应
    // 路径。--env 在 parseArgs 里是 repeatable flag（env 组共用），取值数组
    // 的最后一项；--new-env → camelCase newEnv 是普通字符串 flag。
    const envFlag = Array.isArray(flags.env) ? (flags.env as string[]).filter(Boolean).pop() : undefined;

    const newEnvFlag = typeof flags.newEnv === 'string' && flags.newEnv.trim() ? flags.newEnv.trim() : undefined;

    await runAgentLoop({

      base: `http://127.0.0.1:${PORT}`,

      agentDir: process.cwd(),

      envId: envFlag,

      newEnvRecipe: newEnvFlag,

    });

    return;

  }



  // Help flag for sub-commands

  if (flags.help) {

    const result = await callApi('help', { path: positional });

    printResult('help', 'help', result, jsonMode);

    return;

  }



  const group = positional[0];

  const action = positional[1] || 'list';



  // Simple commands (no subcommand)

  let result: Record<string, unknown>;

  if (group === 'status') {

    result = await callApi('status');

    printResult('status', 'status', result, jsonMode);

  } else if (group === 'reload') {

    result = await callApi('reload', { workspacePath: flags.workspacePath });

    printResult('reload', 'reload', result, jsonMode);

  } else if (group === 'version') {

    result = await callApi('version');

    printResult('version', 'version', result, jsonMode);

  } else {

    // Build request body based on group/action

    const restArgs = positional.slice(2);

    const body = buildRequestBody(group, action, restArgs, flags, passthroughArgs);

    const route = buildRoute(group, action, restArgs);



    // `task update` notification merge (issue #205 cross-review): Rust

    // `TaskStore::update` REPLACES `notification` wholesale when the field

    // is present, so a partial CLI patch like `--notificationDesktop false`

    // would clear sibling keys. Read the current notification

    // and merge the user's flags on top so partial updates are non-

    // destructive. Limited to the `task update` path — `create-direct`

    // doesn't need merging since there's nothing to preserve. The fetch

    // round-trip is unconditional on this path (only fires when a

    // --notification* flag was actually passed) so it costs nothing in the

    // common "interval-only" patch case.

    if (

      group === 'task'

      && action === 'update'

      && body

      && (body as Record<string, unknown>).notification !== undefined

    ) {

      const idForFetch = (body as Record<string, unknown>).id as string | undefined;

      if (idForFetch) {

        const fetched = await callApi(`task/get`, { id: idForFetch });

        if (fetched.success && fetched.data) {

          const existing =

            ((fetched.data as Record<string, unknown>).task as Record<string, unknown> | undefined)

            ?? (fetched.data as Record<string, unknown>);

          const existingNotif = (existing.notification as Record<string, unknown> | undefined) ?? {};

          const userNotif = (body as Record<string, unknown>).notification as Record<string, unknown>;

          // Order matters: spread existing first so user values win.

          (body as Record<string, unknown>).notification = { ...existingNotif, ...userNotif };

        }

        // Best-effort: if the get fails (rare — task ids are local), fall

        // through with the partial. Rust will surface the real error on the

        // subsequent update call.

      }

    }



    result = await callApi(route, body);



    // `env adopt` 公钥不通 → 现场隐藏输入 guest 密码，带 password 重试一次

    // （P2 V6：密码不落盘、不进 shell 历史、不进命令行参数）。

    if (

      group === 'env' &&

      action === 'adopt' &&

      !result.success &&

      typeof result.error === 'string' &&

      result.error.includes('公钥登录不通') &&

      process.stdin.isTTY

    ) {

      const password = await promptHiddenInput('公钥登录不通。输入 guest 登录密码（现场使用，不落盘；直接回车放弃）: ');

      if (password) {

        result = await callApi(route, { ...(body as Record<string, unknown>), password });

      }

    }



    // `env exec` 缺 guest 密码 / 认证失败 → 现场隐藏输入 guest 密码，带

    // guestPassword 重试一次（P2 B2：vmrun 客户机通道只认密码；密码不落盘、

    // 不进 shell 历史、不进命令行参数）。

    if (

      group === 'env' &&

      action === 'exec' &&

      !result.success &&

      typeof result.error === 'string' &&

      result.error.includes('guest 密码') &&

      process.stdin.isTTY

    ) {

      const guestPassword = await promptHiddenInput('输入 guest 密码（现场使用，不落盘；直接回车放弃）: ');

      if (guestPassword) {

        result = await callApi(route, { ...(body as Record<string, unknown>), guestPassword });

      }

    }



    // --run bundled with `task create-from-alignment`: chain immediately

    // into /task/run using the fresh task_id. Saves the caller one round

    // trip and removes the "which id did I just get?" parsing step.

    // Only fires on success and only when the response actually carries

    // a task.id (older backends without the enriched payload fall

    // through without the run — graceful degradation).

    if (

      group === 'task' &&

      action === 'create-from-alignment' &&

      flags.run &&

      result.success &&

      result.data

    ) {

      const data = result.data as Record<string, unknown>;

      const task = (data.task as Record<string, unknown>) ?? data;

      const newTaskId = task?.id as string | undefined;

      if (newTaskId) {

        const runResult = await callApi('task/run', { id: newTaskId });

        if (!runResult.success) {

          // Flag the failure in the top-level result so exit code reflects

          // it, but keep the successful create payload visible so the user

          // can manually `task run <id>` next. Stick the run error in a

          // distinct field to avoid clobbering the create data.

          result.success = false;

          result.error = `created ${newTaskId} but run failed: ${String(runResult.error ?? 'unknown error')}`;

        } else {

          // Bundle the run result alongside create so printTaskCreateResult

          // can show both sections (task_id + docs_path + runtime/model).

          (result.data as Record<string, unknown>).runResult = runResult.data;

        }

      }

    }



    printResult(group, action, result, jsonMode, flags);

  }



  // Exit with proper code: 0 = success, 1 = business error

  if (result && !result.success) process.exit(1);

}



function buildRoute(group: string, action: string, rest: string[]): string {

  // AppCraft nested record commands: appcraft record start/stop/status

  if (group === 'appcraft' && action === 'record') {

    const recordAction = rest[0] || 'status';

    return `appcraft/record/${recordAction}`;

  }

  // MCP OAuth subcommands: mcp oauth discover/start/status/revoke

  if (group === 'mcp' && action === 'oauth') {

    const oauthAction = rest[0] || 'status';

    return `mcp/oauth/${oauthAction}`;

  }

  // Tool readmes: `zhishi widget ...` — the server returns a brief readme

  // (or the widget design contract) as raw text.

  if (action === 'readme' && group === 'widget') {

    return `readme/${group}`;

  }

  // `widget` only exists for readme lookup — any form of invocation

  // (`zhishi widget`, `zhishi widget chart`, `zhishi widget readme chart`)

  // routes to the same handler. The handler parses modules from the payload.

  if (group === 'widget') {

    return 'readme/widget';

  }

  // `task remove` is an alias for `task delete` — the cron CLI uses `remove`

  // for the same operation, so AI / users who generalize the verb hit a real

  // route instead of the previous opaque "Unknown admin route" 404 (issue

  // #205 gap #4). buildRequestBody already treats them as the same shape.

  if (group === 'task' && action === 'remove') {

    return 'task/delete';

  }

  // `zhishi env engines` — admin routes live under environment/* (P1 E1).

  if (group === 'env') {

    return `environment/${action}`;

  }

  return `${group}/${action}`;

}



// Read a --*-file flag payload (term write --data-file).

// Same 1 MB cap + NUL check as the other --*-file flags.// + actionable error. These flags exist to bypass Windows shell-quoting

// losses — the AI writes the payload to disk and passes a path instead of an

// inline arg that may get mangled/dropped.

/**

 * 隐藏输入读取（env adopt 的 guest 密码）。不回显；非 TTY 返回空串，

 * 调用方按「未提供密码」处理。密码只活在内存里传给本次 API 调用。

 */

function promptHiddenInput(question: string): Promise<string> {

  if (!process.stdin.isTTY) return Promise.resolve('');

  return new Promise((resolve) => {

    // 提示语必须先直接写出——下面的 _writeToOutput 置空会连 rl.question
    // 的 query 一起吞掉（2026-08-15 实测：用户看到「卡住」，其实在等密码）。

    process.stdout.write(question);

    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });

    (rl as unknown as { _writeToOutput?: (s: string) => void })._writeToOutput = () => {};

    rl.question('', (answer) => {

      rl.close();

      process.stdout.write('\n');

      resolve(answer);

    });

  });

}



function readTextFileFlag(flagName: string, filePath: string): string {

  try {

    // Lazy-require keeps cold path short for non-term commands.

    const fs = require('fs') as typeof import('fs');

    const MAX_BYTES = 1024 * 1024; // 1 MB — pathological for a terminal/script payload

    const stat = fs.statSync(filePath);

    if (stat.size > MAX_BYTES) {

      console.error(`Error: --${flagName} "${filePath}" is ${stat.size} bytes, exceeds ${MAX_BYTES} (1 MB) limit`);

      process.exit(1);

    }

    const raw = fs.readFileSync(filePath, 'utf-8');

    if (raw.includes('\0')) {

      console.error(`Error: --${flagName} "${filePath}" contains NUL bytes (is this a binary file?)`);

      process.exit(1);

    }

    return raw;

  } catch (err) {

    console.error(`Error: failed to read --${flagName} "${filePath}": ${err instanceof Error ? err.message : String(err)}`);

    process.exit(1);

  }

}



function buildRequestBody(

  group: string,

  action: string,

  rest: string[],

  flags: Record<string, unknown>,

  passthrough: string[] = [],

): Record<string, unknown> {

  // 域包清单层（P2 多域抽象层）
  if (group === 'domain') {
    if (action === 'check') {
      return { id: rest[0] ?? flags.id };
    }
    return {};
  }

  // Memory（记忆库检索：agent 按需想起的通道）
  if (group === 'memory') {
    if (action === 'search') {
      return {
        q: rest.join(' ') || flags.query,
        kinds: flags.kind ? String(flags.kind).split(',') : undefined,
        limit: flags.limit ? Number(flags.limit) : undefined,
      };
    }
  }

  // Research（安全研究员版 P1 D1：研究成败信号）。枚举在 CLI 侧校验
  // （§4 输出侧本体）——非法值直接拒绝，不发给 server。
  if (group === 'research') {
    if (action === 'log') {
      const taskKind = String(flags.taskKind ?? '');
      const outcome = String(flags.outcome ?? '');
      const summary = String(flags.summary ?? '');
      const bugClass = flags.bugClass ? String(flags.bugClass) : undefined;
      if (!isResearchTaskKind(taskKind)) {
        console.error(`Error: --task-kind 非法 "${taskKind}"（允许：${RESEARCH_TASK_KINDS.join(' / ')}）`);
        process.exit(1);
      }
      if (!isResearchOutcome(outcome)) {
        console.error(`Error: --outcome 非法 "${outcome}"（允许：${RESEARCH_OUTCOMES.join(' / ')}）`);
        process.exit(1);
      }
      if (bugClass !== undefined && !isResearchBugClass(bugClass)) {
        console.error(`Error: --bug-class 非法 "${bugClass}"（允许：${RESEARCH_BUG_CLASSES.join(' / ')}）`);
        process.exit(1);
      }
      if (!summary.trim()) {
        console.error('Error: research log requires --summary "<成败/卡点的一句话>"');
        process.exit(1);
      }
      return {
        workspace: flags.workspace ? String(flags.workspace) : process.cwd(),
        taskKind,
        outcome,
        summary,
        bugClass,
        trajectoryRef: flags.trajectoryRef ? String(flags.trajectoryRef) : undefined,
      };
    }
    if (action === 'list') {
      const taskKind = flags.taskKind ? String(flags.taskKind) : undefined;
      const outcome = flags.outcome ? String(flags.outcome) : undefined;
      if (taskKind !== undefined && !isResearchTaskKind(taskKind)) {
        console.error(`Error: --task-kind 非法 "${taskKind}"（允许：${RESEARCH_TASK_KINDS.join(' / ')}）`);
        process.exit(1);
      }
      if (outcome !== undefined && !isResearchOutcome(outcome)) {
        console.error(`Error: --outcome 非法 "${outcome}"（允许：${RESEARCH_OUTCOMES.join(' / ')}）`);
        process.exit(1);
      }
      return {
        taskKind,
        outcome,
        limit: flags.limit ? Number(flags.limit) : undefined,
      };
    }
  }

  // ===== 内嵌终端（AI-driven embedded terminal）=====

  if (group === 'term') {

    if (action === 'open') {

      // 没有显式 --cwd 时回退到进程 cwd，保证 workspacePath 始终存在，
      // 否则 Rust 端反序列化会 422 "missing field `workspacePath`"。
      const workspacePath = String(flags.cwd || process.cwd()).trim();

      return {

        workspacePath,

        rows: flags.rows ? Number(flags.rows) : undefined,

        cols: flags.cols ? Number(flags.cols) : undefined,

        // --cmd：在终端里直接运行指定命令（ssh/docker exec 等），缺省走默认 shell。

        cmd: flags.cmd ? String(flags.cmd) : undefined,

        // --env：D14 边界标记（host/docker:<c>/vm:<name>/range:<host>），

        // env≠host 的终端后续 write/read 走界内自动放行（boundary 门控）。

        env: flags.env ? String(flags.env) : undefined,

      };

    }

    if (action === 'write') {

      const terminalId = requirePositional(rest[0], 'terminalId', 'term write');

      // --data-file：Windows 下 AI 发的

      // 带引号/换行的 positional 可能被 shell 吃掉；写文件传路径最稳。

      let data = rest.slice(1).join(' ');

      if (flags.dataFile && typeof flags.dataFile === 'string') {

        data = readTextFileFlag('data-file', flags.dataFile);

      }

      // 提示词约定：AI 用字面量 "\n" 表示换行。CLI 在此把它还原成真实的
      // 换行符（0x0A），否则 panel-api 会原样写入 PTY，终端把它当成普通
      // 文本而非回车。Rust 端是 as_bytes 直写，不负责转义。
      data = data.replace(/\\n/g, '\n');

      if (!data) {

        console.error('Error: term write requires non-empty data. Pass it as a positional arg or --data-file <path>.');

        console.error('  → Tip: 换行用 \\n 表示（CLI 会自动转成真实换行）或把整段输入写进文件后传 --data-file。');

        process.exit(1);

      }

      return { terminalId, data };

    }

    if (action === 'read') {

      return {

        terminalId: requirePositional(rest[0], 'terminalId', 'term read'),

        cursor: flags.cursor !== undefined ? Number(flags.cursor) : undefined,

      };

    }

    if (action === 'close') {

      return { terminalId: requirePositional(rest[0], 'terminalId', 'term close') };

    }

    return {};

  }

  // MCP commands

  if (group === 'mcp') {

    if (action === 'add') {

      return {

        server: {

          id: flags.id,

          name: flags.name,

          type: flags.type || 'stdio',

          command: flags.command,

          args: flags.args,

          url: flags.url,

          env: parseEnvFlags(flags.env as string[] | undefined),

          headers: parseEnvFlags(flags.headers as string[] | undefined),

          description: flags.description,

        },

        dryRun: flags.dryRun,

      };

    }

    if (action === 'remove' || action === 'enable' || action === 'disable' || action === 'test') {

      return { id: rest[0] || flags.id, scope: flags.scope };

    }

    if (action === 'show') {

      return { id: requirePositional(rest[0] ?? (flags.id as string | undefined), 'mcp-id', 'mcp show', 'id') };

    }

    if (action === 'oauth') {

      const oauthAction = rest[0] || 'status'; // discover | start | status | revoke

      const serverId = rest[1] || (flags.id as string);

      if (!serverId) return { id: undefined }; // will trigger missing field error

      if (oauthAction === 'start') {

        return {

          id: serverId,

          clientId: flags.clientId,

          clientSecret: flags.clientSecret,

          scopes: flags.scopes,

          callbackPort: flags.callbackPort ? Number(flags.callbackPort) : undefined,

        };

      }

      return { id: serverId };

    }

    if (action === 'env') {

      const serverId = rest[0];

      const subAction = rest[1]; // set | get | delete

      const envPairs = rest.slice(2);

      // For 'delete', bare keys (no =value) are valid — convert to KEY=1 for parseEnvFlags

      const envInput = subAction === 'delete'

        ? envPairs.map(k => k.includes('=') ? k : `${k}=`)

        : envPairs;

      return {

        id: serverId,

        action: subAction,

        env: parseEnvFlags(envInput.length > 0 ? envInput : flags.env as string[] | undefined),

      };

    }

    return {};

  }



  // Model commands

  if (group === 'model') {

    if (action === 'set-key') return { id: rest[0] || flags.id, apiKey: rest[1] || flags.apiKey };

    if (action === 'verify') return { id: rest[0] || flags.id, model: flags.model };

    if (action === 'set-default') return { id: rest[0] || flags.id };

    if (action === 'add') {

      // Structure the provider object from flags

      const provider: Record<string, unknown> = {

        id: flags.id,

        name: flags.name,

        baseUrl: flags.baseUrl,

        models: flags.models,           // array (repeatable)

        modelNames: flags.modelNames,   // array (repeatable)

        modelSeries: flags.modelSeries,

        primaryModel: flags.primaryModel,

        authType: flags.authType,

        apiProtocol: flags.protocol,    // --protocol maps to apiProtocol

        upstreamFormat: flags.upstreamFormat,

        maxOutputTokens: flags.maxOutputTokens,

        vendor: flags.vendor,

        websiteUrl: flags.websiteUrl,

        timeout: flags.timeout,

        disableNonessential: flags.disableNonessential,

      };

      // Build aliases from --aliases sonnet=model-id,opus=model-id

      if (typeof flags.aliases === 'string') {

        const aliases: Record<string, string> = {};

        for (const pair of (flags.aliases as string).split(',')) {

          const [k, v] = pair.split('=');

          if (k && v) aliases[k.trim()] = v.trim();

        }

        provider.aliases = aliases;

      }

      return { provider, dryRun: flags.dryRun };

    }

    if (action === 'remove') return { id: rest[0] || flags.id };

    return {};

  }



  // Agent commands

  if (group === 'agent') {

    if (action === 'enable' || action === 'disable') return { id: rest[0] || flags.id };

    if (action === 'show') return { id: requirePositional(rest[0] ?? (flags.id as string | undefined), 'agent-id', 'agent show', 'id') };

    if (action === 'set') return { id: rest[0], key: rest[1], value: tryParseJson(rest[2]) };

    return {};

  }





  // Environment engine probe (P1 E1): `zhishi env engines [--fresh]`.

  // Pure query — `--fresh` bypasses the server-side 30s detect cache.

  // Named environments (P1 E3): list / add / remove / open.

  // Environment recipes + docker lifecycle (P1 E4): recipes / up / down / ps.

  if (group === 'env') {

    if (action === 'engines') return { forceFresh: flags.fresh === true };

    if (action === 'install') {
      // 引擎自动安装引导（P1 E1b）：zhishi env install docker|hyperv
      return { engine: requirePositional(rest[0] ?? (flags.engine as string | undefined), 'engine', 'env install', 'engine') };
    }

    if (action === 'list') return {};

    if (action === 'recipes') return {};

    if (action === 'ps') return {};

    if (action === 'up') {

      // 与 env open 一致：无 --cwd 时回退进程 cwd，保证 workspace 存在。

      // vm 配方另需 --vm-base（模板 .vmx）；--user/--key-path 可选（回写 env

      // 条目用，env open 走 SSH 时消费）。

      return {

        recipe: requirePositional(rest[0] ?? (flags.recipe as string | undefined), 'recipe', 'env up', 'recipe'),

        workspace: String(flags.cwd || process.cwd()).trim(),

        vmBase: flags.vmBase,

        user: flags.user,

        keyPath: flags.keyPath,

      };

    }

    if (action === 'down') {

      return { id: requirePositional(rest[0] ?? (flags.id as string | undefined), 'instance-id', 'env down', 'id') };

    }

    if (action === 'rm') {

      return { id: requirePositional(rest[0] ?? (flags.id as string | undefined), 'instance-id', 'env rm', 'id') };

    }

    if (action === 'exec') {

      // guest-exec 通道（P2 B2）：zhishi env exec <env-id> [--guest-user u] -- <command...>

      // `--` 之后的部分原样拼成 guest 命令；guest 密码不走 flag（防 shell 历史

      // 泄漏）——缺密码/认证失败时由主流程现场隐藏输入后带 guestPassword 重试。

      if (passthrough.length === 0) {

        console.error('Error: env exec requires `--` followed by the guest command.');

        console.error('  Usage: zhishi env exec <env-id> [--guest-user <user>] -- <command...>');

        process.exit(1);

      }

      return {

        id: requirePositional(rest[0] ?? (flags.id as string | undefined), 'env-id', 'env exec', 'id'),

        command: passthrough.join(' '),

        guestUser: flags.guestUser,

      };

    }

    if (action === 'adopt') {

      // 模板认领（P2 V6）：zhishi env adopt pwn-vm --vm <模板.vmx> [--user]

      // [--key-path] [--password-ref env:VAR]。密码不走 flag（防 shell 历史

      // 泄漏）——公钥不通时由主流程现场隐藏输入后带 password 重试；

      // passwordRef 是引用不是本体（D-T4），可以走 flag。

      return {

        recipe: requirePositional(rest[0] ?? (flags.recipe as string | undefined), 'recipe', 'env adopt', 'recipe'),

        vmx: flags.vm,

        user: flags.user,

        keyPath: flags.keyPath,

        passwordRef: flags.passwordRef,

      };

    }

    if (action === 'build') {

      // 模板构建（P2 V7）：zhishi env build pwn-vm [--iso <路径>]

      // [--disk-gb N] [--mem-mb N] [--cpus N]。数字收敛在 server 侧做。

      return {

        recipe: requirePositional(rest[0] ?? (flags.recipe as string | undefined), 'recipe', 'env build', 'recipe'),

        isoPath: flags.iso,

        diskGb: flags.diskGb,

        memMb: flags.memMb,

        cpus: flags.cpus,

      };

    }

    if (action === 'add') {

      // 参数式：--kind ssh --id xxx --host ...（校验在 server 侧统一做）

      return {

        id: rest[0] ?? flags.id,

        kind: flags.kind,

        name: flags.name,

        host: flags.host,

        container: flags.container,

        vmName: flags.vmName,

        address: flags.address,

        user: flags.user,

        keyPath: flags.keyPath,

        port: flags.port,

      };

    }

    if (action === 'remove') {

      return { id: requirePositional(rest[0] ?? (flags.id as string | undefined), 'env-id', 'env remove', 'id') };

    }

    if (action === 'open') {

      // 与 term open 一致：无 --cwd 时回退进程 cwd，保证 workspacePath 存在。

      return {

        id: requirePositional(rest[0] ?? (flags.id as string | undefined), 'env-id', 'env open', 'id'),

        workspacePath: String(flags.cwd || process.cwd()).trim(),

        rows: flags.rows ? Number(flags.rows) : undefined,

        cols: flags.cols ? Number(flags.cols) : undefined,

      };

    }

    return {};

  }



  // Generative UI widget readme. Accept any of:

  //   zhishi widget                         → action='list',    rest=[]           → modules=[]

  //   zhishi widget readme                  → action='readme',  rest=[]           → modules=[]

  //   zhishi widget readme chart            → action='readme',  rest=['chart']    → modules=['chart']

  //   zhishi widget readme chart interactive → rest=['chart','interactive']       → modules=['chart','interactive']

  //   zhishi widget chart                   → action='chart',   rest=[]           → modules=['chart']

  //   zhishi widget chart interactive       → action='chart',   rest=['interactive'] → modules=['chart','interactive']

  // Modules = positional args AFTER `widget`, minus any leading `readme`/`list` keyword.

  if (group === 'widget') {

    const candidates = [action, ...rest].filter(Boolean);

    const modules = candidates[0] === 'readme' || candidates[0] === 'list'

      ? candidates.slice(1)

      : candidates;

    return { modules };

  }



  // Skill commands

  if (group === 'skill') {

    if (action === 'remove' || action === 'info' || action === 'enable' || action === 'disable') {

      return { name: rest[0] || flags.name, scope: (flags.scope as string) || 'user' };

    }

    return {};

  }



  // AppCraft (PRD 0.2.36 §6.4-6.6) — workspace app-automation recordings + replay

  if (group === 'appcraft') {

    if (action === 'list') {

      return { workspacePath: flags.workspace };

    }

    if (action === 'record') {

      const recordAction = rest[0] || 'status';

      if (recordAction === 'start') {

        return {

          // appId 可选（design C 零配置）：省略时录制器从首个工具调用自动识别应用

          appId: (flags.app as string | undefined) ?? '',

          workspacePath: flags.workspace,

        };

      }

      return {};

    }

    if (action === 'replay') {

      return {

        target: requirePositional(rest[0] ?? (flags.target as string | undefined), 'skillName|recordingDir', 'appcraft replay', 'target'),

        vars: parseEnvFlags(flags.var as string[] | undefined),

        workspacePath: flags.workspace,

        dryRun: flags.dryRun,

        allowHighRisk: flags.yesHighRisk === true,

      };

    }

    return {};

  }



  // Config commands

  if (group === 'config') {

    if (action === 'get') return { key: rest[0] || flags.key };

    if (action === 'set') return { key: rest[0] || flags.key, value: tryParseJson(rest[1] ?? String(flags.value ?? '')), dryRun: flags.dryRun };

    return {};

  }



  // Task Center (v0.1.69) — covers all `zhishi task <action>` subcommands.

  //

  // The `actor` / `source` trust fields are NOT settable via the CLI; the

  // admin-api handler derives them from the calling process environment

  // (ZHISHI_PORT present → agent subprocess; otherwise user terminal).

  if (group === 'task') {

    if (action === 'list') {

      return {

        workspaceId: flags.workspaceId,

        status: flags.status,

        tag: flags.tag,

        includeDeleted: flags.includeDeleted,

      };

    }

    if (action === 'get') return { id: requirePositional(rest[0] ?? (flags.id as string | undefined), 'task-id', 'task get', 'id') };

    if (action === 'update-status') {

      return {

        id: rest[0],

        status: rest[1],

        message: flags.message,

      };

    }

    if (action === 'append-session') {

      return { id: rest[0], sessionId: rest[1] || flags.sessionId };

    }

    if (action === 'archive') return { id: rest[0], message: flags.message };

    // `remove` is the cron-side vocabulary for the same operation; before this

    // alias the CLI accepted `task remove` and forwarded to a non-existent

    // /api/admin/task/remove route, leaving the user with an opaque "Unknown

    // admin route" error (issue #205 gap #4). Accept both so AI / users who

    // generalized from `cron remove` don't hit a dead end.

    if (action === 'delete' || action === 'remove') return { id: rest[0] };

    if (action === 'create-direct') {

      assertStringFlag(flags.name, 'name');

      // Resolve task.md body: `--taskMdFile` (industry-standard for long

      // text — avoids shell-escape hell for multi-line / backtick / quoted

      // markdown) takes precedence over `--taskMdContent` when both are

      // set. Mirrors the `cron add --prompt-file` pattern above.

      const taskMdContent = resolveTaskMdContent(flags);

      const executionMode = (flags.executionMode as string | undefined) ?? 'once';

      maybeWarnRecurringWithoutInterval(executionMode, flags);

      return {

        name: rest[0] || flags.name,

        executor: flags.executor ?? 'agent',

        description: flags.description,

        workspaceId: flags.workspaceId,

        workspacePath: flags.workspacePath,

        taskMdContent,

        executionMode,

        runMode: flags.runMode,

        sourceThoughtId: flags.sourceThoughtId,

        tags: typeof flags.tags === 'string'

          ? (flags.tags as string).split(',').map(s => s.trim()).filter(Boolean)

          : undefined,

        // Scheduling-detail fields the Rust TaskCreateDirectInput already

        // accepts. Before issue #205 only the create-from-alignment path

        // (which inherits them from the alignment session) could populate

        // these; the CLI parser dropped them on create-direct, forcing every

        // recurring task to default to 60 min and every cron / dispatchAt

        // schedule to be set via GUI afterward.

        intervalMinutes: parseIntervalMinutesFlag(flags.intervalMinutes),

        cronExpression: flags.cronExpression,

        cronTimezone: flags.cronTimezone,

        dispatchAt: parseDispatchAtFlag(flags.dispatchAt),

        notification: buildNotificationFromFlags(flags),

        // Per-task model override (D20: runtime/permissionMode/runtimeConfig

        // overrides were removed with the external runtimes).

        model: flags.model,

      };

    }

    if (action === 'update') {

      // Patch shape mirrors `create-direct`: the same flag set, but every

      // field is optional. Rust `TaskUpdateInput` treats `None` as

      // "leave unchanged" except for the explicit clear-override flag

      // (`clearProviderOverride`), which the CLI

      // exposes for the AI's "reset to follow Agent" intent.

      const id = requirePositional(rest[0] ?? (flags.id as string | undefined), 'task-id', 'task update', 'id');

      // `--taskMdFile` / `--taskMdContent` map to TaskUpdateInput.prompt

      // (Rust writes the body to task.md atomically under the row's write

      // lock). Reuse the create-side helper so size / NUL / file-not-found

      // errors stay consistent.

      const promptFromTaskMd =

        flags.taskMdFile !== undefined || flags.taskMdContent !== undefined

          ? resolveTaskMdContent(flags)

          : undefined;

      const executionMode = flags.executionMode as string | undefined;

      if (executionMode) maybeWarnRecurringWithoutInterval(executionMode, flags);

      const body: Record<string, unknown> = { id };

      if (flags.name !== undefined) body.name = flags.name;

      if (flags.executor !== undefined) body.executor = flags.executor;

      if (flags.description !== undefined) body.description = flags.description;

      if (executionMode !== undefined) body.executionMode = executionMode;

      if (flags.runMode !== undefined) body.runMode = flags.runMode;

      if (flags.intervalMinutes !== undefined) body.intervalMinutes = parseIntervalMinutesFlag(flags.intervalMinutes);

      if (flags.cronExpression !== undefined) body.cronExpression = flags.cronExpression;

      if (flags.cronTimezone !== undefined) body.cronTimezone = flags.cronTimezone;

      if (flags.dispatchAt !== undefined) body.dispatchAt = parseDispatchAtFlag(flags.dispatchAt);

      if (flags.model !== undefined) body.model = flags.model;

      if (flags.providerId !== undefined) body.providerId = flags.providerId;

      if (flags.clearProviderOverride) body.clearProviderOverride = true;

      if (typeof flags.tags === 'string') {

        body.tags = (flags.tags as string).split(',').map(s => s.trim()).filter(Boolean);

      }

      const notification = buildNotificationFromFlags(flags);

      // CLI merges with existing notification before sending — see the

      // notification-merge block in main() so partial patches like

      // `--notificationDesktop false` don't clobber sibling keys.

      if (notification !== undefined) body.notification = notification;

      if (promptFromTaskMd !== undefined) body.prompt = promptFromTaskMd;

      return body;

    }

    if (action === 'create-from-alignment') {

      // First positional MUST be the alignmentSessionId. Use --name for the

      // task title (to avoid ambiguity when the user writes a task name that

      // happens to parse as a sessionId). An empty alignmentSessionId will be

      // rejected by the Rust layer's `validate_safe_id`.

      assertStringFlag(flags.name, 'name');

      return {

        name: flags.name,

        executor: flags.executor ?? 'agent',

        description: flags.description,

        workspaceId: flags.workspaceId,

        workspacePath: flags.workspacePath,

        alignmentSessionId: flags.alignmentSessionId ?? rest[0],

        executionMode: flags.executionMode ?? 'once',

        runMode: flags.runMode,

        sourceThoughtId: flags.sourceThoughtId,

        tags: typeof flags.tags === 'string'

          ? (flags.tags as string).split(',').map(s => s.trim()).filter(Boolean)

          : undefined,

        // Identical override contract to create-direct above — keep these two

        // in lockstep.

        model: flags.model,

      };

    }

    if (action === 'run' || action === 'rerun') {

      return { id: rest[0] || flags.id };

    }

    return {};

  }




  return flags;

}



/** Parse KEY=VALUE pairs from --env flags */

function parseEnvFlags(envPairs: string[] | undefined): Record<string, string> | undefined {

  if (!envPairs || envPairs.length === 0) return undefined;

  const result: Record<string, string> = {};

  for (const pair of envPairs) {

    const eqIdx = pair.indexOf('=');

    if (eqIdx > 0) {

      result[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);

    }

  }

  return Object.keys(result).length > 0 ? result : undefined;

}




/** Try to parse a string as JSON, otherwise return as-is */

function tryParseJson(value: string | undefined): unknown {

  if (value === undefined) return undefined;

  try {

    return JSON.parse(value);

  } catch {

    return value;

  }

}



/** Hard cap for `--taskMdContent` (inline string). Mirrors the `--taskMdFile`

 *  1 MB cap so neither ingress path can ship a pathologically large body

 *  through to Rust, where it would bloat `.task/<id>/task.md` without bound. */

const TASK_MD_MAX_BYTES = 1024 * 1024;



/**

 * Resolve `task create-direct --taskMdFile` / `--taskMdContent` into a

 * single `taskMdContent` string.

 *

 * Precedence (both flags set → `--taskMdFile` wins):

 *   1. `--taskMdFile <path>` — read the file (size + NUL guarded).

 *      Chosen as primary because inline markdown on the shell is hostile to

 *      backticks, quotes, and newlines.

 *   2. `--taskMdContent <string>` — raw inline content (size-guarded).

 *

 * Earlier revisions silently joined trailing positional args as a "legacy"

 * fallback — that was undocumented surface area and a fat-fingered positional

 * could silently become task body. Removed after cross-review (v0.1.69).

 */

function resolveTaskMdContent(

  flags: Record<string, unknown>,

): string | undefined {

  const filePath = flags.taskMdFile;

  if (filePath !== undefined && filePath !== '') {

    if (typeof filePath !== 'string') {

      console.error('Error: --taskMdFile must be a file path string');

      process.exit(2);

    }

    try {

      // Lazy require — same pattern as the cron `--prompt-file` reader

      // (keeps startup fast for commands that don't need fs).

      const fs = require('fs') as typeof import('fs');

      const stat = fs.statSync(filePath);

      if (stat.size > TASK_MD_MAX_BYTES) {

        console.error(`Error: --taskMdFile "${filePath}" is ${stat.size} bytes, exceeds ${TASK_MD_MAX_BYTES} (1 MB) limit`);

        process.exit(1);

      }

      const raw = fs.readFileSync(filePath, 'utf-8');

      if (raw.includes('\0')) {

        console.error(`Error: --taskMdFile "${filePath}" contains NUL bytes (is this a binary file?)`);

        process.exit(1);

      }

      return raw;

    } catch (err) {

      console.error(`Error: failed to read --taskMdFile "${filePath}": ${err instanceof Error ? err.message : String(err)}`);

      process.exit(1);

    }

  }

  const contentFlag = flags.taskMdContent;

  if (typeof contentFlag === 'string' && contentFlag !== '') {

    // Byte-length cap — a 1 MB inline arg on the shell is almost always a

    // copy-paste gone wrong, and downstream JSON serialisation / logging

    // would otherwise choke silently.

    const byteLen = Buffer.byteLength(contentFlag, 'utf-8');

    if (byteLen > TASK_MD_MAX_BYTES) {

      console.error(`Error: --taskMdContent is ${byteLen} bytes, exceeds ${TASK_MD_MAX_BYTES} (1 MB) limit. Use --taskMdFile for large content.`);

      process.exit(1);

    }

    return contentFlag;

  }

  return undefined;

}


/**

 * Build a `notification` sub-object from the `--notification*` flags so the

 * Rust `TaskCreateDirectInput.notification` / `TaskUpdateInput.notification`

 * field (`Option<NotificationConfig>`) round-trips cleanly.

 *

 * Returns `undefined` when no notification flag was set — the Rust update

 * path treats `None` as "leave unchanged", and create-direct already defaults

 * to `{ desktop: true }` via serde so omitting it is the right behavior.

 *

 * Flags supported:

 *   --notificationDesktop true|false        Toggle desktop notification (default true)

 *   --notificationEvents done,blocked,...   Comma-separated event filter

 */

function buildNotificationFromFlags(

  flags: Record<string, unknown>,

): Record<string, unknown> | undefined {

  const desktop = flags.notificationDesktop;

  const events = flags.notificationEvents;

  if (

    desktop === undefined

    && events === undefined

  ) {

    return undefined;

  }

  const out: Record<string, unknown> = {};

  if (desktop !== undefined) {

    // Accept `true` / `false` strings (CLI parser leaves un-quoted bools as

    // strings) and any truthy/falsy value; explicit `false` MUST disable.

    if (typeof desktop === 'boolean') {

      out.desktop = desktop;

    } else if (typeof desktop === 'string') {

      const v = desktop.toLowerCase();

      if (v === 'false' || v === '0' || v === 'no' || v === 'off') {

        out.desktop = false;

      } else {

        out.desktop = true;

      }

    } else {

      out.desktop = !!desktop;

    }

  }

  if (events !== undefined) {

    if (typeof events !== 'string') {

      console.error('Error: --notificationEvents must be a comma-separated string (e.g. done,blocked,endCondition)');

      process.exit(2);

    }

    const eventsList = events.split(',').map(s => s.trim()).filter(Boolean);

    if (eventsList.length === 0) {

      // Empty list would silently mean "subscribe to nothing" — almost

      // certainly a typo (`--notificationEvents=,,,` or empty string).

      console.error('Error: --notificationEvents resolved to an empty list. Pass at least one event (e.g. done,blocked,endCondition) or omit the flag to use the default set.');

      process.exit(2);

    }

    out.events = eventsList;

  }

  return out;

}



/**

 * Parse `--dispatchAt` flag into milliseconds since epoch. Accepts either a

 * raw epoch-ms integer (what Rust persists) or an ISO 8601 / RFC 3339 string

 * (what humans type). Bails with a precise error on unparseable input — a

 * silent fall-through would later become a confusing "task never fires"

 * because Rust treats `None` as "no schedule".

 */

function parseDispatchAtFlag(raw: unknown): number | undefined {

  if (raw === undefined) return undefined;

  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;

  if (typeof raw !== 'string' || raw.trim().length === 0) {

    console.error('Error: --dispatchAt must be a number (epoch ms) or an ISO 8601 timestamp');

    process.exit(2);

  }

  const trimmed = raw.trim();

  // Pure-integer path: epoch-ms (the Rust wire format). `parseInt` would

  // silently chop `"123abc"`; require the whole string to be digits to

  // surface typos.

  if (/^-?\d+$/.test(trimmed)) {

    const n = Number(trimmed);

    if (Number.isFinite(n)) return n;

  }

  const ms = Date.parse(trimmed);

  if (Number.isNaN(ms)) {

    console.error(`Error: --dispatchAt "${raw}" is not a valid timestamp (try epoch ms or ISO 8601, e.g. 2026-06-01T09:00:00+08:00)`);

    process.exit(2);

  }

  return ms;

}



/**

 * Recurring tasks with no explicit interval / cron silently default to 60min

 * on the Rust side (`schedule_from_task` falls through to

 * `interval_minutes.unwrap_or(60).max(5)`). Surface this so the AI / user

 * doesn't ship a "let me poll every minute" task that quietly runs hourly.

 * Print to stderr so JSON output stays parseable.

 */

function maybeWarnRecurringWithoutInterval(

  executionMode: string,

  flags: Record<string, unknown>,

): void {

  if (executionMode !== 'recurring') return;

  if (flags.intervalMinutes !== undefined || flags.cronExpression !== undefined) {

    return;

  }

  console.error(

    'Warning: --executionMode recurring without --intervalMinutes or --cronExpression — '

    + 'task will run every 60 minutes (Rust default). Add --intervalMinutes <n> to set the cadence.',

  );

}



/**

 * Parse `--intervalMinutes` into a positive integer. Without this validator

 * `Number("abc")` produces `NaN`, which `JSON.stringify` emits as `null`,

 * which Rust serde drops via `#[serde(default)]` → the task silently falls

 * back to the 60-minute default with no error surfaced to the user.

 * Codex review (issue #205) caught this as a class-of-bug pattern.

 */

function parseIntervalMinutesFlag(raw: unknown): number | undefined {

  if (raw === undefined) return undefined;

  const n = typeof raw === 'number' ? raw : Number(raw);

  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {

    console.error(`Error: --intervalMinutes must be a positive integer (got: ${JSON.stringify(raw)})`);

    process.exit(2);

  }

  if (n < 5) {

    // The Rust scheduler clamps to .max(5), so anything lower would silently

    // be ignored. Reject so the user knows their "every 2 min" turned into

    // "every 5 min" before they ship a misconfigured cadence.

    console.error(`Error: --intervalMinutes minimum is 5 (got: ${n}). The scheduler enforces this floor; lower values are silently clamped.`);

    process.exit(2);

  }

  return n;

}



// ---------------------------------------------------------------------------

// Entry

// ---------------------------------------------------------------------------



main().catch(err => {

  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);

  process.exit(1);

});

