# Agent instructions

This repository publishes Agent Skills (`skills/`, `optional/`) and hosts Factory v0 (`factory/`).

## Factory

Before you change `factory/`, read `.factory/handoff.md`, then `.factory/plan.md` and `.factory/state.json`. Chat history is not needed. For the latest factory run on this machine, read `.factory/runs/last-run.md`.

- Checks: `cd factory && npm install && npm run check`, and `terraform -chdir=factory/infra validate` after changing `factory/infra/`.
- At each milestone, update `.factory/handoff.md` and `work.tasks` in `.factory/state.json`. `factory/cli.ts` writes only to `.factory/runs/`, which is gitignored and never committed.
- Never write secrets into `.factory/`, task files, or logs.

## Skills

`scripts/check-discover.sh` verifies that the published skill listing matches `scripts/expected-skills.txt`.
