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

## Optional pack

The default catalog includes architect, arena, blast-radius, bro, show-me-your-work, teach, technical-writing, and why. Extra workflow skills stay under `optional/`. Install them with `--full-depth` and the skill filters below.

```bash
npx skills@latest add olibyte/agent-toolkit --full-depth \
  -s swarm -s interrogate -s figure-it-out \
  -s create-verification-skill -s maintain-verification-skill \
  -a claude-code -a cursor -a codex -a antigravity -a antigravity-cli -y
```

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
