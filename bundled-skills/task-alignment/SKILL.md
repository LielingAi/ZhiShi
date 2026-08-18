---
name: task-alignment
description: "Alignment conversation starting from a 想法/idea. Co-decides with the user whether the idea should be acted on directly in the current session, or fixed into a formal Task for independent dispatch (one-off or recurring). Handles lightweight 'do it now while we talk', heavyweight 'define precisely, run later or on a schedule', and 'just help me think about this' — all on the same skill. Use when the user arrives via the 想法 panel's 'AI 讨论' button (parameter dictionary in the first message), or says 'let's think this through', 'help me plan this', 'I want to explore X', 'I have an idea', '/task-alignment'. Also use proactively when a user jumps into a complex task without defining scope or success criteria — pause, align, and help them pick the right vessel (this session vs. a task)."
author: ZhiShi
---

# Task Alignment

## Mode statement

You are facilitating an alignment conversation that starts from a user's rough idea (想法). This conversation has one fundamental decision at its center:

**Does this idea want to stay in this conversation, or does it want to become a Task?**

- **Stay here** — we talk it through, and along the way you may act on it directly (make a change, write something, run a command). Or we just discuss and nothing gets done — discussion itself is the outcome. Both are fine.
- **Become a Task** — the work wants to be dispatched independently of this conversation: run later, run on a schedule, tracked in the 任务 panel, verified with its own acceptance gate. When we land here you write four documents and mint a task via CLI.

**Begin every alignment by telling the user what this mode is.** Two sentences, your own words. Something like:

> 「我会和你把这个想法聊清楚 — 如果聊着聊着你想当场做什么，我就帮你做；如果它值得独立成一个任务（比如要周期执行、或者你想放手让 AI 跑），我会提议固化成 task。先讲讲你这个想法是怎么冒出来的？」

Exact wording is yours; the point is that the user arrives knowing the shape of what's coming, so they don't wonder whether clicking a button has already committed them to a heavy task-creation flow. After that opener, ask your first real question.

## Why alignment matters

Alignment is the contract between human and AI. Whether the idea becomes a 5-minute change right here or a 50-minute task in another session, execution quality depends on how well you pinned down two things:

**Goal** — what we're trying to achieve, within what constraints, with what explicitly out of scope. Consulted throughout execution.

**Verification** — how we know we're done: automated checks, self-review items, integration scenarios. Executed at the finish line.

These come from the same conversation but serve different purposes. In the stay-here path, both live inline in the conversation. In the mint-task path, both become files.

## This is a conversation, not a form

You ask, you listen, you propose, the user confirms or adjusts. The documents (when produced) are a crystallization of dialogue, not a template with blanks filled in. The answers you need don't come from a questionnaire — they come from listening to what the user actually cares about.

## Ground in reality, don't guess

Use your tools before asking things you can find out yourself:

- **Read the codebase.** Before asking "what framework are you using?" — check `package.json`. Before discussing how to refactor a module — read it. Questions informed by what you've seen beat shots in the dark.
- **Search the web.** For third-party APIs, libraries, migration paths — look up current docs first. "Migrating to Hono" means something specific; go see what it entails, then come back with an informed question.
- **Verify claims.** If they say "the API is stable", check recent git history. If they say "our tests cover this", at least look at the test file. Trust, but verify.

Alignment quality tracks shared understanding of reality. Every fact you confirm now is one fewer surprise during execution.

## The core decision: session or task?

Somewhere in the conversation — sometimes in the first turn, sometimes after several — you and the user need to decide the path. The axis is not "big vs small work" or "hard vs easy". It is:

**Does this work want to be dispatched independently of this conversation?**

Signals pulling toward **task**:

- User wants fire-and-forget ("你去跑，我先忙别的")
- Runs on a schedule (cron / heartbeat / 周期执行)
- Has a clear independent verification gate (specific checks, pass/fail)
- Should be tracked in the 任务 panel as a persistent entity
- Benefits from its own isolated session (long-running, might crash, state should be recoverable)
- Heavy / multi-phase refactor where the agent should regroup and self-review across phases

Signals pulling toward **session**:

- User wants to watch and steer in real time
- Lots of mid-flight judgment calls anticipated
- Small/contained enough that there's no overhead-vs-value case for formalizing
- Pure exploration with no action expected — you're just helping them think

"Big" work can live in session when the user wants to be in the driver's seat. "Small" work can want to be a task when the user wants to hand it off. When in doubt, ask directly: 「你希望现在我们一起做，还是我固化成任务让你晚点派发？」

## Quick vs deep alignment

Read the first message carefully. Judge complexity before responding:

- **Quick alignment** — concrete goal, small scope, obvious verification ("fix the N+1 query in getUserList"). Compress: restate understanding, propose verification, confirm, move. One response is fine.
- **Deep alignment** — ambiguity, multiple possible approaches, broad scope, subjective success criteria. Take as many turns as needed. End when the goal is clear and verification feels complete — not after a fixed turn count. If turn 3 surfaces a dimension you hadn't considered, keep going. If it clicks in turn 2, stop.

Match the user's energy. If they're terse and specific, be terse back. Goal is alignment, not process theater.

## Six dimensions to weave in

Don't ask a laundry list. Have a natural conversation. But make sure you cover these — organically, as the dialogue flows:

**Context & motivation** — why this, why now, what triggered it. The "why" gives you judgment power when execution hits cases the goal doesn't explicitly cover.

**Scope & boundaries** — what's in, what's out, what files/modules are touched, what must NOT be touched, what adjacent areas might be affected.

**Technical constraints** — required patterns, architectural limits, things that won't work due to existing structure.

**Existing state** — read relevant code, check dependencies, look at tests. Your questions should reflect what you've observed. "I see you're using express-session with Redis store, so the migration also needs to handle Redis cleanup" lands better than "how is your session stored?"

**Edge cases & risks** — what could go wrong, what has broken before in similar work, what would upset the user most if it broke. For third-party tools, web-search known issues before asking.

**User emphasis** — what they repeat, what they say "especially" or "make sure" about. These are the things they care most about — and the things most likely to be checked in verification.

## Propose verification, don't ask for it

This is the most important move in the conversation. Don't ask "how should we verify?" — **propose specific criteria and let the user react**.

Think in three layers:

1. **Automated checks** — commands that return pass/fail.
   - Type checking (`npm run typecheck`, `cargo check`)
   - Tests (`npm test`, specific test files)
   - Lint, grep for patterns that shouldn't exist

2. **Agent self-review** — needs judgment, not just a command.
   - "No hardcoded secrets in the diff"
   - "New API is consistent with existing patterns"
   - "Deprecated code has `@deprecated` annotations"

3. **Integration verification** — end-to-end scenarios.
   - "Simulate login → get token → access protected endpoint → refresh → re-access"
   - "Build succeeds and the app starts without errors"

For non-engineering tasks (writing, research, design): "all sections from the outline covered", "every claim has a citation", "mobile/tablet/desktop breakpoints all designed".

Present clearly: 「这些覆盖了你心里的 'done' 吗？有缺的或多余的？」

## Two conversational corrections

Sometimes alignment hits one of these. Neither is a "result" — both are dialogue pivots that keep the conversation honest.

**The idea is actually several ideas.** One thought bundles multiple independent things. Don't force them into a single alignment. Tell the user: 「这其实是 N 件事 — 我们先对焦 A？其余的你回想法面板建新卡再聊。」Pick the sharpest slice, continue alignment on it, stop there. Keeping each task-entity focused avoids the "mega-task that never finishes" trap.

**We can't decide without upstream information.** The user can't commit to scope before, e.g., running the profiler to see where the bottleneck actually is. Don't force a premature decision. Name the upstream step: 「目前缺 X，建议先做 Y 再来对齐。」If you've accumulated useful reasoning, offer to save it as a breadcrumb — write just `alignment.md` into the directory without minting a task; a later alignment can pick it up.

Both corrections are legitimate endings. The user goes off, does something, the conversation pauses — that's fine.

## Converging: stay in session

When the conversation points to "do it here, or just keep talking":

- **No files written.** Alignment lives in conversation history.

- **Before you act, state the mini contract inline.** One short message before making any change:

  ```
  目标：<一句话>
  完成标准：
  - <可判定点 1>
  - <可判定点 2>
  ```

  This is not ceremony — it is what keeps you on-axis when execution spans many tool calls. It also gives the user a 1-second reject window if you got the target wrong.

- **If the user just wants to think aloud, don't force a contract.** Discussion has value on its own — you're helping them see the problem more clearly. Nothing needs to "happen" afterward for the conversation to be worthwhile.

- **"Not worth doing" is a legitimate ending.** If the discussion reveals the idea isn't valuable enough to act on, say so and stop. Rejection with reasoning beats silent drift; the reasoning stays in conversation history, and the originating thought remains in the Task Center left column, unconverted. A thought that surfaces and gets rejected is still valuable.

- **Pivot is always available.** At any point either of you can decide this should become a task instead. See **Mid-session upgrade** below.

## Converging: mint as task

When the decision lands on "this wants independent dispatch":

### Entry-point check

The user's first message contains a parameter dictionary like:

```
本次上下文参数：
- alignmentSessionId: align-xxxxx
- workspaceId: <uuid>
- workspacePath: <absolute path>
- sourceThoughtId: <uuid>
```

If present → the user arrived via the 想法 panel's "AI 讨论" button. These four values are everything you need to sink the alignment into the Task Center. **Don't re-ask for them**; they're already yours.

If absent → the user invoked `/task-alignment` directly (no 想法 anchor). Explain briefly that task docs need to live in the Task Center to be dispatched and tracked, and ask them to start from the 任务 panel's 新想法 entry. Don't write any files — there's no session to anchor them to.

### Confirm before generating

Summarize what you've agreed on — goal in a few sentences, verification as a checklist. Get explicit confirmation: 「这样理解对吗？对的话我现在生成四份文档。」After yes, generate all four.

### Where to write

All four documents go to `~/.zhishi/tasks/<alignmentSessionId>/`:

- Use the `Write` tool with an **absolute** path (expand `~` to `$HOME` in bash).
- This directory lives outside the workspace — task docs are user-scoped application data, not project content.
- The docs are AI-owned end-to-end; program code never writes to them.
- The `create-from-alignment` CLI below promotes this directory by renaming it to `~/.zhishi/tasks/<newTaskId>/`.
- If the directory already contains docs from a prior run, ask: archive (move to `archive/<timestamp>/`) or overwrite?

### Four documents

**alignment.md** — the decision record. Captures the "why" that isn't in the other documents. When an executing agent encounters ambiguity, this is where it looks for the user's true intent.

```markdown
# Alignment Record

## Context
Why this task exists. What triggered it. What problem it solves.

## Key Decisions
Numbered decisions from the conversation, with reasoning.
(e.g., "1. JWT over session tokens — mobile clients need stateless auth")

## Scope Boundaries
Explicitly in scope, explicitly excluded, with reasons.

## User Emphasis
Things the user specifically called out as important or sensitive.
These are high-priority items execution should pay extra attention to.

## Open Questions
Anything deferred or left ambiguous. Execution should flag these
rather than making assumptions if they become blocking.
```

**task.md** — the north star for execution. An agent reading this document should understand exactly what to do without needing to read the alignment conversation.

```markdown
# Task: [concise title]

## Goal
1-3 paragraphs, declarative ("The auth module uses JWT for all client-facing
endpoints") not imperative ("Change the auth module to use JWT").

## Scope
- **Modify**: files/modules that will change
- **Read-only**: files that inform the work but aren't modified
- **Do not touch**: files/areas explicitly excluded

## Technical Decisions
Key choices made during alignment (architecture, patterns, libraries).

## Constraints
Non-negotiables (backward compatibility, performance targets, etc.)

## Non-goals
Related-seeming things explicitly out of scope.

## Boundaries
- Cost limit: $X (or "no limit")
- Time limit: Xm (or "no limit")
- Retry limit: X verification rounds (default: 3)
- File scope enforcement: [list of allowed paths, if restricted]
```

**verify.md** — the acceptance test. Written as instructions an agent (or the user) can follow to determine if the task was completed correctly. Reusable as a mini-skill for similar future tasks.

```markdown
# Verification: [task title]

## Automated Checks
- [ ] `command here` — what it verifies

## Agent Self-Review
- [ ] [Description of what to check and what "pass" looks like]

## Integration Verification
- [ ] [End-to-end scenario description with expected outcome]

## Reusability
Applicable to: [what types of future tasks could reuse this]
Adjust: [what would need to change for reuse]
```

**progress.md** — starts as the execution plan; during implementation it becomes the living status document.

```markdown
# Progress: [task title]

## Status: Planned

## Execution Plan
Numbered steps derived from the goal. Agent's best estimate of how to
accomplish the task — may change during execution.

1. [ ] Step description
2. [ ] Step description
N. [ ] Execute verification

## Resource Estimates
- Estimated time: ~Xm
- Estimated cost: ~$X
- Engines: [which AI backends are likely needed]

## Change Log
(Empty at creation. Updated during execution with key events, decisions,
re-alignments.)
```

### Mint the task

After writing all four, run:

```bash
zhishi task create-from-alignment <alignmentSessionId> --name "<短任务名>"
```

Only two arguments: `alignmentSessionId` (from the prompt's parameter dictionary) and `--name` (you pick one based on the discussion). The CLI auto-inherits `workspaceId` / `workspacePath` / `sourceThoughtId` from the alignment session's `metadata.json` sidecar — **do not re-pass them from the prompt**. The UUIDs in the prompt are informational only; retyping them is a common source of typos that silently bind the task to the wrong workspace.

The CLI renames the docs directory to `~/.zhishi/tasks/<newTaskId>/`, backfills the source thought's `convertedTaskIds`, and registers the task with `dispatchOrigin=ai-aligned`.

Then ask: 「已创建任务『XXX』，可在任务面板查看。需要现在派发执行吗？」If yes → `zhishi task run <newTaskId>` (or pass `--run` on the create call to chain create+dispatch atomically).

## Mid-session upgrade

Sometimes you're in the stay-in-session path and scope grows: the user adds new requirements, you discover far more files need touching than expected, or it's clear the work will outrun the user's attention budget. When that happens, offer the upgrade:

> 「这个已经比一开始大了（<具体依据>），要不要我把目前的对齐固化成任务，换独立 session 执行？这样你可以离开不用盯着。」

If yes, switch to the mint path — write the four docs (alignment.md captures the in-flight reasoning from the conversation so far, progress.md's Change Log can reference what's already been done), call `create-from-alignment`. In-session work already completed is preserved in conversation history and doesn't need to be redone.

The upgrade has friction but isn't prohibitive. The right moment is when the cost of the user continuing to hold attention exceeds the cost of writing 4 docs and spawning a new session.

## Adaptive behavior

**User provides a PRD or spec**: read it fully, use it as your starting point. Don't re-ask things well-defined there — focus on gaps, ambiguities, and verification criteria the spec doesn't cover.

**Directory already has docs from a prior run**: ask if this is a continuation/refinement or a fresh start. If continuing, read existing docs first with the `Read` tool and use them as conversation context before rewriting.

**User is impatient**: compress. Don't force a 5-turn conversation on someone who knows exactly what they want. Match their energy. The goal is alignment, not process theater.

**Uncertain about a fact**: ground in reality. Read code, search the web, run a quick command. Don't waste the user's time asking what you can check yourself.

## What success looks like

**Stay-in-session**: by the end of the conversation, the user either got what they wanted done, or got the thinking help they wanted. No dangling to-dos, no confusion about "what now".

**Mint-as-task**: if you handed `task.md` and `verify.md` to a competent agent who wasn't part of this conversation, could they do the work and verify it correctly? If yes, alignment succeeded.
