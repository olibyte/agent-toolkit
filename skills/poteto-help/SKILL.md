---
name: poteto-help
description: Guides users through this catalog, /poteto-mode, and picking the skill, playbook, or principle for a task. Type /poteto-help with a question.
license: MIT
---

Codex `$poteto-help`. Claude Code, Cursor, and Antigravity `/poteto-help`.

# Poteto help

Answer the user's question about this catalog, hand them a prompt they can send, and link the file the answer came from. For a help question, don't start the work. The user asked how, and a rigorous run spends real tokens, so let them send the prompt.

A message that asks for work, such as "use poteto-mode to fix this bug", is not a help question. Read [`poteto-mode`](../poteto-mode/SKILL.md), do the work under it, and mention once how to keep it on for the host they are using.

This file maps questions to the skills that hold the answers. Those files own the details. Read the file you route to before you quote it, and trust it when it disagrees with this map. Give the user the file's public copy: `https://github.com/olibyte/agent-toolkit/blob/main/` followed by its path under `skills/` or `optional/`.

## Find out what they need

Infer the need from the message and the conversation. A named situation, such as "which skill reviews a PR?", goes straight to its section. If the need is still unclear, ask one multiple-choice question with these options, then answer only the section they pick:

- Get set up
- Start a task with `/poteto-mode`
- Pick a skill for a situation
- Fix a run that went wrong
- Make the catalog my own

Check the state that changes the answer, and mention it only when it does:

- No `.agents/models.md` means every role inherits the chat model.
- No `verify-*` skill in the project means agents have no scripted way to drive the app. Mention `create-verification-skill` when the question is about proving a change works and that skill is installed.

When models matter, ask whether the user wants to pin a model for each role now. It matters when the user is new, the question is about setup or cost, or the answer depends on which models run. Ask at most once per chat. Offer two choices:

- Now: tell them to copy `templates/models.md` to `.agents/models.md` and uncomment the roles they want to pin, and answer their question too.
- Later: answer their question, and add one line saying every role inherits the chat model until they add `.agents/models.md`.

## Get set up

1. Install with `npx skills add olibyte/agent-toolkit` for the default catalog. Add `--full-depth` and `-s` flags for optional skills.
2. Copy `templates/models.md` to `.agents/models.md` when you want to pin subagent models. Leave it uncommitted when the team does not share models.
3. Start a real task with `/poteto-mode` (Codex: `$poteto-mode`), a goal, and a check that can pass or fail.

Installing changes nothing until the user invokes a skill. The [README](../../README.md) has the install command. Offer to word their first prompt with them, per [`references/prompting.md`](references/prompting.md).

If cost is the worry, say where the tokens go and how to spend fewer. The catalog spends extra tokens on subagents and review panels. A role set to `inherit` or `auto` in `.agents/models.md` runs on the chat's model. A shorter panel list runs fewer subagents, one for each entry. Save `/poteto-mode` for work that needs rigor.

Cursor can keep `/poteto-mode` on as a Custom Mode. Claude Code, Codex, and Antigravity invoke `$poteto-mode` or `/poteto-mode` at the start of each task.

## Start a task with `/poteto-mode`

`/poteto-mode` matches the task to a playbook, copies the playbook's steps into the todo list, and runs the other skills as the steps need them. A step it skips stays in the list as `skip: <reason>`. A good prompt states the goal and how to tell it's done. It doesn't list skills, because a hand-written sequence tends to drop or reorder steps the playbook would keep. Read [`references/prompting.md`](references/prompting.md) before you help word one.

Whether `/poteto-mode` stays on depends on the host:

- A single invocation attaches the skill to one message. It fades as the chat moves on.
- In Cursor, Option+Enter on Mac or Alt+Enter on Windows, or Use as Mode from the skill entry, makes it a Custom Mode. It stays in context every turn until the user exits the mode, and it stays out of casual turns.
- On other hosts, start each new task with `$poteto-mode` or `/poteto-mode`.

Mid-chat, "new task" makes the mode match a fresh playbook. Playbook code-writing delegates read `references/poteto-agent.md`.

## Pick a skill

The default answer is `/poteto-mode`, which runs most of the others when its steps need them. Name a skill directly when the user wants more or less of something than the playbook gives. Read the skill before you recommend it, and give one example prompt. Optional skills are used when installed and skipped with a reason when they are not.

| The user wants to | Skill |
|---|---|
| Do any non-trivial task with rigor | [`/poteto-mode`](../poteto-mode/SKILL.md) |
| Know how code works now, or where new code should live | [`/how`](../how/SKILL.md) |
| Know why code is shaped this way, or where a number came from | [`/why`](../why/SKILL.md) |
| Understand a change or subsystem, explained plainly | [`/teach`](../teach/SKILL.md) |
| Catch up on their own recent work on a topic | [`/recall`](../recall/SKILL.md) |
| Catch up on everything in this chat since their last message, with enough context to decide each action item | [`/ketchup`](../ketchup/SKILL.md) |
| Know what a small diff could break outside itself | [`/blast-radius`](../blast-radius/SKILL.md) |
| Settle types and module shape before code that crosses a function boundary | [`/architect`](../architect/SKILL.md) |
| Get several attempts at one brief, merged into the best one | [`/arena`](../arena/SKILL.md) |
| Run parallel checks over slices, or race workers | [`/swarm`](../../optional/swarm/SKILL.md), when installed |
| Have different models review a diff and try to break it | [`/interrogate`](../../optional/interrogate/SKILL.md), when installed |
| Fix a bug test-first when a cheap local test exists | [`/tdd`](../tdd/SKILL.md) |
| Apply TypeScript rules to `.ts` or `.tsx` work | [`/typescript-best-practices`](../typescript-best-practices/SKILL.md) |
| Strip comments before review, using a reviewer that didn't write them | [`/no-comments`](../no-comments/SKILL.md) |
| Clean AI tells out of prose | [`/unslop`](../unslop/SKILL.md) |
| Write docs, an RFC, a README, a PR description, or a commit message to a standard | [`/technical-writing`](../technical-writing/SKILL.md) |
| Hear the last reply again in plain words | [`/bro`](../bro/SKILL.md) |
| Switch coding agents without losing the thread | [`/handoff`](../handoff/SKILL.md) |
| Give agents a scripted way to drive the app and prove behavior | [`/create-verification-skill`](../../optional/create-verification-skill/SKILL.md), when installed |
| Bring a verification skill and its feature map back in line with the app | [`/maintain-verification-skill`](../../optional/maintain-verification-skill/SKILL.md), when installed |
| Vet a performance number before reporting or acting on it | [`/benchmark-checklist`](../benchmark-checklist/SKILL.md) |
| Run a large or cross-cutting change, or one to review after stepping away | [`/figure-it-out`](../../optional/figure-it-out/SKILL.md), when installed |
| Keep a decision log during a run, and review it afterward | [`/show-me-your-work`](../show-me-your-work/SKILL.md) |
| Pin a model for each role | copy [`templates/models.md`](../../templates/models.md) to `.agents/models.md` |
| Turn their own working habits into a personal mode skill | [`/automate-me`](../../optional/automate-me/SKILL.md), when installed |
| Turn what a finished task taught into skill edits | [`/reflect`](../../optional/reflect/SKILL.md), when installed |
| Stop agents from repeating the same mistakes in this repo | [`/correct`](../correct/SKILL.md) |
| Find their way around the catalog | `/poteto-help` |

Principles live in one skill, [`principles`](../principles/SKILL.md), with one file per rule under `references/`. They are not separate slash skills.

Close calls:

- `/how` explains what the code does. `/why` explains the reasons. `/teach` runs one or both and explains the result plainly.
- `/arena` gives every worker the same brief and merges the best parts. `/swarm` splits work into slices or a race and returns one report.
- `/architect` implements right after it settles the design. Add "with checkpoint" to review the design before it writes code.
- `/interrogate` reviews the diff. `/blast-radius` looks for breakage outside the diff and proves the one fact that makes the change safe.
- `/recall` rebuilds context across recent chats. `/ketchup` covers only this chat since the user's last message. Resuming one specific chat or branch is the Session pickup playbook.
- `/figure-it-out` designs one rigorous run. The Orchestrate playbook runs a program that spans days and many PRs. The Autonomous run playbook drives one task to a finish condition.

Not in this catalog:

- `/deslop`, `control-cli`, and `control-ui` are Cursor plugin skills. This catalog uses `/unslop` and the project's verification skill.
- `/loop` and `/create-skill` are Cursor built-ins. Author a skill with the poteto-mode authoring playbook.
- There is no `/orchestrate` skill. Orchestrate is a `/poteto-mode` playbook.

## Playbooks and principles

Playbooks are step lists inside `/poteto-mode`, not skills, so they have no slash command. Inside `/poteto-mode`, describing the task picks one, and these phrases name one directly:

- "babysit this pr" or "check on pr 123" runs Babysit. It drives the PR to merge-ready and stops there. It doesn't merge unless the user asks to merge, land, or ship.
- "land the stack" runs Shipping.
- "take over this branch" runs Session pickup.
- "pause safely" runs Pause safely.
- "full autopilot on this queue" runs Autopilot-full. "stack them, don't ship" runs Autopilot-stack.
- "run the eval playbook" runs Eval.

Without `/poteto-mode`, a phrase such as "babysit this pr" can start the host's own skill for the same job instead. The Playbooks section of [`poteto-mode`](../poteto-mode/SKILL.md) lists every playbook and when it applies.

This catalog has no separate planning skill. For work that spans phases or stacked PRs, asking `/poteto-mode` for a plan runs the [Multi-phase plan playbook](../poteto-mode/playbooks/multi-phase-plan.md), which writes the plan and doesn't implement it. For a design question, the Prototype playbook or `/architect` settles it in code first.

Principles are files under the `principles` skill that `/poteto-mode` reads and cites in its replies. The user rarely invokes one. They steer with the names instead, as in "apply prove it works. show me the real output." The file is `skills/principles/references/principle-<kebab-title>.md`.

## Fix a run that went wrong

| Symptom | Fix |
|---|---|
| The mode stopped applying after a few turns | It was started for one message. In Cursor, start it as a Custom Mode. On other hosts, start each task with `/poteto-mode`. |
| A question got treated as the next step of the last task | Say "new task", or say the turn doesn't need the mode. |
| A new model choice had no effect | `.agents/models.md` applies to new chats. Start one. |
| Runs cost more than expected | See the cost paragraph under Get set up. |
| A skill didn't load on its own | Skills load when the user types them or when `/poteto-mode` runs them, and it doesn't run every skill. |
| Parallel agents overwrote each other | Give each agent its own worktree. |
| An overnight run moved but finished nothing | A wake loop needs a check that can pass or fail, not a duration. |
| The reply claims success from a green build | Ask for the real command, flow, stored value, or profile. That's the prove-it-works principle. |

For a run that drifts, [`references/prompting.md`](references/prompting.md) has one-line steers. [`references/recipes.md`](references/recipes.md) has prompts worth copying.

## Make the catalog my own

- [`/automate-me`](../../optional/automate-me/SKILL.md), when installed, drafts a personal mode skill from the user's own history, to use alongside `/poteto-mode`.
- [`/reflect`](../../optional/reflect/SKILL.md), when installed, after a session turns its lessons into skill edits the user approves.
- `/poteto-mode write a skill for <workflow>` runs the authoring playbook. The eval playbook tests a skill change blind.
- Fix a misbehaving skill in its own PR, not inside the feature work where it went wrong.

## Reply

Lead with the answer. Give at most one example prompt in a code block, adapted from [`references/recipes.md`](references/recipes.md) when one fits, then the link to that file. Keep it short unless the user asked for the whole map.
