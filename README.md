# agent-toolkit

Curated Agent Skills you drop into a project. They work in Claude Code, Cursor, Codex CLI, and Antigravity CLI.

## Install

Install into a project (not `-g`):

```bash
npx skills@latest add olibyte/agent-toolkit \
  -a claude-code -a cursor -a codex -a antigravity -a antigravity-cli -y
```

To install from a local clone, use the same `-a` flags with the clone path:

```bash
npx skills@latest add /absolute/path/to/agent-toolkit \
  -a claude-code -a cursor -a codex -a antigravity -a antigravity-cli -y
```

Then copy `templates/AGENTS.md` to the consumer repo root if `AGENTS.md` is missing. Copy `templates/CLAUDE.md` to `CLAUDE.md` if that file is missing.

## Poteto mode

`poteto-mode` is the working style in this catalog. It came from [pstack](https://github.com/cursor/plugins/tree/main/pstack). An agent that applies it matches the task to a playbook, names the data shape before it writes code, delegates implementation, and checks the real artifact. Casual turns skip it.

Invoke it when the work needs that rigor. Codex: `$poteto-mode`. Claude Code, Cursor, and Antigravity: `/poteto-mode`. The agent instructions and playbooks live in [`skills/poteto-mode/SKILL.md`](skills/poteto-mode/SKILL.md).

## Optional skills

A default install does not include these. They live under `optional/` so the catalog a Codex session sees stays small. Install them with `--full-depth` and the skill names you want. Drop `-s` flags you do not need.

```bash
npx skills@latest add olibyte/agent-toolkit --full-depth \
  -s swarm -s interrogate -s figure-it-out \
  -s create-verification-skill -s maintain-verification-skill \
  -a claude-code -a cursor -a codex -a antigravity -a antigravity-cli -y
```

Invoke the same way as the default skills. Codex: `$swarm`. Claude Code, Cursor, and Antigravity: `/swarm`. Same pattern for each name.

- **swarm.** Fan out N workers, wait, return one report. Coverage slices or a race.
- **interrogate.** Several models review the same diff. You get a verdict. It does not apply the fixes.
- **figure-it-out.** No bundled playbook fits. The agent designs a playbook first, then runs it.
- **create-verification-skill.** Writes a project-local `verify-<app>` skill under `.agents/skills/` that drives the real UI or CLI.
- **maintain-verification-skill.** Re-reads that feature map against source and a live pass, then ships at most one PR of proven corrections.

After install they sit next to the default skills. poteto-mode calls swarm, interrogate, and figure-it-out when those names are present, and skips with a reason when they are not.

## Commit

Commit these paths so the team shares the same skills and baseline:

- `.agents/skills/`
- `.claude/skills/`
- `skills-lock.json`
- `AGENTS.md`
- `CLAUDE.md`

## Switch tools

Chat history does not follow you across tools. Files do. Run `handoff` before you leave.

## Spec

- [Agent Skills specification](https://agentskills.io/specification)
- [Vercel Skills CLI](https://github.com/vercel-labs/skills)
