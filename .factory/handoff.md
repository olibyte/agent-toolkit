# Factory handoff

Read this file, `.factory/plan.md`, and `.factory/state.json` (the task list) before you continue. Chat history is not needed. Run records are local to the machine that ran them: `.factory/runs/last-run.md` and `.factory/runs/state.json`, both gitignored.

## Current goal

Factory v0 is proven end to end on an ephemeral EC2 worker. The next goal is to merge olibyte/agent-toolkit#4, then harden the worker before running real agent tasks. See "Next recommended action".

## Completed work

- T1 to T9 are done. The `factory/` package has task-state, notifications (console and Slack webhook), github, worker (local and ec2), the orchestrator, the CLI, and Terraform in `infra/`. `terraform validate` passes with Terraform 1.16.4 and AWS provider 6.x.
- `cd factory && npm run check` passes: `tsc` strict and 59 `node:test` tests. They cover state transitions, orchestration (happy path, verify failure, launch and ready failures, blocked, escalation, termination failure, auto-merge), a real git push to a bare origin with a fake `gh`, and the EC2 provider against a scripted fake `aws`.
- T12: the AWS setup is done. Identity Center user `olibyte-admin` has AdministratorAccess on a dedicated `agent-factory` member account, through the SSO profile `agent-factory` (region `ap-southeast-2`). The Terraform in `factory/infra` is applied there: 7 resources, including a $20 monthly budget that alerts `ocben1+agent-factory@gmail.com`. The Terraform state is local to the operator's laptop and gitignored. The controller's name-based lookup finds the security group and instance profile.
- T10, the EC2 proof: run `20260926-015512-9c63` completed in about 2m45s. It launched a `t3.small` in `ap-southeast-2` with no key pair, IMDSv2, and the egress-only security group. The worker installed git 2.50.1 and gh 2.97.0, cloned the sandbox, wrote `proofs/<run>.txt` on the EC2 host, and passed all three verify commands. It pushed `factory/20260926-015512-9c63` and opened olibyte/agent-factory-sandbox#3. The Slack webhook accepted all four events with 0 failures. AWS reports the instance `terminated`, and no factory instances remain.
- T7 local proof against real GitHub: runs `20260925-070547-e6aa` and `20260925-070936-ba02` opened olibyte/agent-factory-sandbox#1 and #2. The sandbox is a private, disposable repo created for these proofs.
- Codex reviewed `factory/` read-only. Two findings were fixed: the GitHub token is now visible only in `prepare` and `publish`, and SIGINT cleanup waits for an in-flight launch. One finding was rejected: the `factory_secret` failure path never echoes the value.

## Current work

- None in progress.

## Important decisions

- The worker runs only controller-rendered bash, one SSM Run Command per phase. There is no SSH, no inbound rule, and IMDSv2 is required. User-data only schedules `shutdown -h +90`, with shutdown behavior `terminate`.
- Node 24 native TypeScript with `node:test`, and no runtime dependencies. `typescript` and `@types/node` are dev-only. The existing poteto-mode tools use Bun, which is not installed here and is not needed on workers.
- Secrets: the worker reads `/agent-factory/github-token` (and optional agent API keys) from SSM Parameter Store, and an IAM Deny blocks every other parameter. The Slack webhook stays on the controller in `FACTORY_SLACK_WEBHOOK_URL`.
- `.factory/state.json` is committed: `work` is hand-maintained, `runs` is written by the CLI. `.factory/runs/` holds logs and events and is gitignored.
- Agent changes default to `sonnet` for Claude Code, with one optional escalated retry (`escalationModel`) after a failed verification.
- The user asked for Terraform, not CloudFormation, so `factory/infra/` replaced the CloudFormation template before anything was deployed. Resources have fixed names (`agent-factory-worker`, `/agent-factory/`), and the CLI finds the security group by name instead of reading Terraform state. State stays local and gitignored for now.
- AWS access: a dedicated member account under IAM Identity Center, with the `agent-factory` SSO profile. `FACTORY_AWS_PROFILE` scopes that profile to factory commands only, so other tools keep their own AWS settings. No root keys.
- Known limit: task code runs as root on the worker and could use the instance role to read `/agent-factory/*`. The next hardening step is to run `change` and `verify` as an unprivileged user with IMDS blocked.

## Blockers

- None.

## Open PRs

- Factory v0 implementation: olibyte/agent-toolkit#4 from `feat/factory-v0`, ready for review.
- Sandbox proof PRs: olibyte/agent-factory-sandbox#1 and #2 (local worker) and #3 (EC2). All are safe to close.

## Next recommended action

1. Review and merge olibyte/agent-toolkit#4.
2. Harden the worker before real agent tasks: run `change` and `verify` as an unprivileged user with IMDS blocked, so task code cannot use the instance role to read `/agent-factory/*`.
3. Prove an `agent` task on EC2 (`factory/examples/agent.task.json`). Store `/agent-factory/anthropic-api-key` first.
4. Move Terraform state to an S3 backend before anyone else runs `apply`.
5. Then start the task tracker, which Factory v0 was the prerequisite for.
