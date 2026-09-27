# Factory handoff

Read this file, `.factory/plan.md`, and `.factory/state.json` (the task list) before you continue. Chat history is not needed. Run records are local to the machine that ran them: `.factory/runs/last-run.md` and `.factory/runs/state.json`, both gitignored.

## Current goal

Build the benchmark app, `olibyte/agent-factory-benchmark`, through the factory. It is a deliberately small task tracker that tests the factory workflow, not application complexity. T16, the scaffold, is done. Next is the planning phase: product brief, factory-generated requirements, architecture, data model, API, and security decisions, acceptance tests, a dependency-aware task graph, Human Gate #1, then parallel implementation. The tasks are in `.factory/state.json`.

## Completed work

- T1 to T9 are done. The `factory/` package has task-state, notifications (console and Slack webhook), github, worker (local and ec2), the orchestrator, the CLI, and Terraform in `infra/`. `terraform validate` passes with Terraform 1.16.4 and AWS provider 6.x.
- `cd factory && npm run check` passes: `tsc` strict and 65 `node:test` tests. They cover state transitions, orchestration (happy path, verify failure, launch and ready failures, blocked, escalation, termination failure, auto-merge), a real git push to a bare origin with a fake `gh`, and the EC2 provider against a scripted fake `aws`.
- T12: the AWS setup is done. Identity Center user `olibyte-admin` has AdministratorAccess on a dedicated `agent-factory` member account, through the SSO profile `agent-factory` (region `ap-southeast-2`). The Terraform in `factory/infra` is applied there: 7 resources, including a $20 monthly budget that alerts `ocben1+agent-factory@gmail.com`. The Terraform state is local to the operator's laptop and gitignored. The controller's name-based lookup finds the security group and instance profile.
- T10, the EC2 proof: run `20260926-015512-9c63` completed in about 2m45s. It launched a `t3.small` in `ap-southeast-2` with no key pair, IMDSv2, and the egress-only security group. The worker installed git 2.50.1 and gh 2.97.0, cloned the sandbox, wrote `proofs/<run>.txt` on the EC2 host, and passed all three verify commands. It pushed `factory/20260926-015512-9c63` and opened olibyte/agent-factory-sandbox#3. The Slack webhook accepted all four events with 0 failures. AWS reports the instance `terminated`, and no factory instances remain.
- T7 local proof against real GitHub: runs `20260925-070547-e6aa` and `20260925-070936-ba02` opened olibyte/agent-factory-sandbox#1 and #2. The sandbox is a private, disposable repo created for these proofs.
- olibyte/agent-toolkit#4 was squash-merged to `main`, and its branch was deleted. The sandbox proof PRs (#1 to #5) were closed and their branches deleted. The sandbox now holds only `main`.
- T13 and T14, merged in olibyte/agent-toolkit#6, with the design in `.factory/plan.md` under "Task setup and worker hardening":
  - Task specs take `packages` (dnf, as root, names validated) and `setup` (commands as the task user in the repo, at the end of `prepare`). `--volume-gb` (default 20) sets an encrypted gp3 root volume.
  - Task-defined commands run as `factory-task` through `setpriv`, with a clean environment. An nftables rule blocks that uid from IMDS, and `prepare` fails if the block is missing. Root never runs git in the task's repo: `publish` applies the task's patch to root's own clone. SSM phase scripts go to a `mktemp` file instead of a fixed `/tmp` path.
  - Tests cover a hook planted in the task repo (it never runs), and a patch forged through `diff.external` that writes into `.git` (publish refuses it). A mutation that publishes from the task repo makes the hook test fail.
  - EC2 proof: run `20260926-024319-c00d` of `factory/examples/toolchain.task.json` completed in 2m12s on a `t3.small`. Task commands ran as `factory-task` (uid 1001). `curl` to IMDS failed and `aws sts get-caller-identity` found no credentials. Root was at least 19 GiB. Setup installed Python 3.12.14 from `packages` and Node v24.18.0 into `~/.local`. The run opened olibyte/agent-factory-sandbox#4 with one commit, which is now closed and its branch deleted. The instance is `terminated`, and its volume is gone.
- T15, the agent proof on EC2: run `20260927-003729-9af5` of `factory/examples/agent.task.json` completed in about 2m40s on a `t3.small`, with no escalation. Claude Code (`sonnet`) ran as `factory-task` and added a `## Usage` section to the sandbox README. The auto-updater's failed global writes did not break the run. The task gained a second verify command, `test -f ~/.claude/skills/handoff/SKILL.md`, which passed as `factory-task`, so the skills install lands in `/home/factory-task/.claude`. The agent can see verify commands in its prompt, and it reported that the file already existed. The run opened olibyte/agent-factory-sandbox#5 with one commit (README.md +4). The instance is `terminated`, and no factory instances remain. The Anthropic API key is in `/agent-factory/anthropic-api-key`. Its spend limit is set in the Anthropic Console, because the AWS budget does not cover API spend.
- T16, the first real-app task, with the design in `.factory/plan.md` under "First real app: benchmark scaffold (T16)":
  - `olibyte/agent-factory-benchmark` is public, created with a README commit. The operator added it to the worker's fine-grained token.
  - Run `20260927-011023-06e6` of `.factory/tasks/benchmark-scaffold.task.json` completed in about 7.5 minutes on a `t3.medium`, with no escalation. `setup` installed Node v24.18.0 (npm 11.16.0) into `~/.local`. Claude Code (`sonnet`) spent about 5 minutes on the change, then all 14 verify commands passed as `factory-task`: `npm ci`, lint, `next build`, the Vitest smoke test, the ignore checks, and 22 skills at their pinned commits in `skills-lock.json`.
  - It opened olibyte/agent-factory-benchmark#1 with one commit: 244 files, +31567 lines, of which 226 paths are the vendored skills. The commit has no `node_modules`, `.next`, `next-env.d.ts`, CI, or product code. The PR diff is too large for GitHub's diff API (20,000-line limit), so review it from a clone.
  - Both PRs are merged: olibyte/agent-factory-benchmark#1 (a merge commit, `689960a` on its `main`) and the T16 docs in olibyte/agent-toolkit#10. Their branches are deleted, as are the leftover `docs/t15-agent-proof` and the run branch `factory/20260927-011023-06e6`.
  - A clean clone of the PR branch also passed `npm ci`, lint, build, and test on the operator's Mac, and the tree stayed clean. Every Slack event was delivered with no sink failures. The instance is `terminated`, and no factory instances or volumes remain.
  - `publish` warned about trailing whitespace in vendored Vercel skill files. `git apply` accepted it, and it is harmless.
- Codex reviewed `factory/` read-only. Two findings were fixed: the GitHub token is now visible only in `prepare` and `publish`, and SIGINT cleanup waits for an in-flight launch. One finding was rejected: the `factory_secret` failure path never echoes the value.

## Current work

- T19, the benchmark CI workflow. The design is in `.factory/plan.md` under "Benchmark CI workflow (T19)", and the task is `.factory/tasks/benchmark-ci.task.json`. It needs the worker token's Workflows permission (read and write). Run it with `node factory/cli.ts run .factory/tasks/benchmark-ci.task.json --worker ec2 --instance-type t3.medium`. It is done when the PR's own `CI` check passes, and passes again on `main` after the merge.

## Important decisions

- The worker runs only controller-rendered bash, one SSM Run Command per phase. There is no SSH, no inbound rule, and IMDSv2 is required. User-data only schedules `shutdown -h +90`, with shutdown behavior `terminate`.
- Node 24 native TypeScript with `node:test`, and no runtime dependencies. `typescript` and `@types/node` are dev-only. The existing poteto-mode tools use Bun, which is not installed here and is not needed on workers.
- Secrets: the worker reads `/agent-factory/github-token` (and optional agent API keys) from SSM Parameter Store, and an IAM Deny blocks every other parameter. The Slack webhook stays on the controller in `FACTORY_SLACK_WEBHOOK_URL`.
- Committed coordination is `.factory/plan.md`, this file, and `.factory/state.json` (the task list only). Run records belong to whoever ran them, so the CLI writes only to the gitignored `.factory/runs/`: `state.json`, `last-run.md`, and per-run logs.
- Agent changes default to `sonnet` for Claude Code, with one optional escalated retry (`escalationModel`) after a failed verification.
- The user asked for Terraform, not CloudFormation, so `factory/infra/` replaced the CloudFormation template before anything was deployed. Resources have fixed names (`agent-factory-worker`, `/agent-factory/`), and the CLI finds the security group by name instead of reading Terraform state. State stays local and gitignored for now.
- AWS access: a dedicated member account under IAM Identity Center, with the `agent-factory` SSO profile. `FACTORY_AWS_PROFILE` scopes that profile to factory commands only, so other tools keep their own AWS settings. No root keys.
- Root runs only controller-rendered steps. Everything the task defines runs as `factory-task`, which is blocked from IMDS. Data crosses from the task user to root only as stdout of a process that runs as the task user (the blocked signal and the patch). Root treats that data as untrusted, and `git apply` refuses `.git/`, `..`, and writes through symlinks.
- Real-app task files live in `.factory/tasks/`, in agent-toolkit. The app repo holds no factory code. App skills are pinned per source to a commit through GitHub tree URLs with `skills@1.7.0`. Use a `t3.medium` or larger for Next.js builds.
- Remaining limits: the task user has open network egress and holds the agent API key during `change`. Only the Claude Code agent path has run on EC2 (T15). The Codex path has passed `bash -n` and tests only. The local worker runs everything as the operator, with no isolation.

## Blockers

- None.

## Open PRs

- None.

## Next recommended action

1. Start the planning phase with the operator's `product-brief.md`. Design how the factory turns it into requirements and a task graph before running any product task.
2. Small follow-ups for the benchmark repo, each as its own factory task: dropping `vite-tsconfig-paths` for Vite's built-in `resolve.tsconfigPaths`, which Vitest suggests; and a decision on npm's `allow-scripts` warning for `unrs-resolver`.
3. Later: T17 moves Terraform state to an S3 backend once a second machine or person applies. T18 builds the task tracker, informed by the first real-app tasks.

Follow the original working method. Record a short design for each new task in `.factory/plan.md` before building it, keep interfaces small, and verify against real systems.
