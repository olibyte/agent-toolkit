# Agent instructions

This repository publishes Agent Skills (`skills/`, `optional/`) and hosts Factory v0 (`factory/`).

## Factory

Before you change `factory/`, read `.factory/handoff.md`, then `.factory/plan.md` and `.factory/state.json`. Chat history is not needed.

- Checks: `cd factory && npm install && npm run check`.
- At each milestone, update the hand-written sections of `.factory/handoff.md` and `work.tasks` in `.factory/state.json`. `factory/cli.ts` owns `runs` and the "Last factory run" block.
- Never write secrets into `.factory/`, task files, or logs.

## Skills

`scripts/check-discover.sh` verifies that the published skill listing matches `scripts/expected-skills.txt`.
