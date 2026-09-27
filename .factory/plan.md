# Factory v0 plan

Prove one remote software task end to end: launch an ephemeral EC2 worker, clone a sandbox repo, make a controlled change, verify it, push a branch, open a PR, notify Slack, terminate the worker, and record the result in `.factory/`.

## Design

```
controller (your machine, Node 24)                 worker (EC2, bash only)
┌───────────────────────────────────────┐          ┌──────────────────────────┐
│ cli.ts ─▶ orchestrator.ts             │  SSM Run │ prepare: git, gh, clone  │
│   task-state/  state machine + store  │  Command │ change:  shell or agent  │
│   notifications/ console + Slack      │ ───────▶ │ verify:  task commands   │
│   worker/  local | ec2 provider       │  (no SSH)│ publish: commit, push,   │
│   github/  publish script + PR parse  │ ◀─────── │          gh pr create    │
│ .factory/runs/ (gitignored)           │  stdout  └──────────────────────────┘
└───────────────────────────────────────┘
```

- **Controller renders, worker runs shell.** Each phase is a bash script the controller renders and sends. The worker needs git and gh, plus an agent CLI only for `agent` tasks. The worker never runs factory TypeScript. One mechanism drives both the local and the EC2 worker.
- **One SSM command per phase.** State transitions then match real progress (`provisioning` covers launch, SSM registration, and clone; `running` covers the change; `verifying` covers verification and publishing). Each phase prints a log tail and one `::factory-result::<json>` line. This keeps output under the 24 KB SSM stdout limit.
- **Secrets.** The worker's GitHub token (and agent API keys) are SecureString parameters under `/agent-factory/`. The worker reads them with its instance role. An explicit Deny blocks every other parameter. The Slack webhook stays on the controller in `FACTORY_SLACK_WEBHOOK_URL`. Secrets never appear in user-data, SSM command parameters, state, or logs.
- **Ephemeral worker.** The worker is Amazon Linux 2023, which ships with the SSM agent and the AWS CLI. It has IMDSv2, no key pair, and a security group with no inbound rules. It uses the default VPC's public subnet for egress. User-data only sets `shutdown -h +90` with shutdown behavior `terminate`, so a crashed controller still cannot leak an instance for long. The orchestrator terminates the worker in a `finally` block and waits for `terminated`.
- **Infra.** Terraform in `factory/infra/` creates the role, the instance profile, and the security group, plus an optional budget. The resources have fixed names (`<name>-worker`, `/<name>/`) and the controller finds them by name, so it never reads Terraform state. `terraform destroy` removes everything. The factory runs in a dedicated AWS account, reached through IAM Identity Center with short-lived credentials.
- **State.** Committed coordination lives in `.factory/`: the plan, the handoff, and `state.json` with the task list. Run records are the operator's data, so the CLI writes only to the gitignored `.factory/runs/`. That covers `state.json` (one record per run: task, transition history, worker ref, PR metadata, error), `last-run.md`, and per-run logs and events.
- **Recovery.** A run records its worker ref as soon as the instance launches. `factory cleanup <run>` terminates a leftover worker and fails the run.
- **Models.** An `agent` change defaults to a cost-efficient model alias. When `escalationModel` is set, a failed verification gets exactly one retry on the stronger model.

### State machine

```
queued ─▶ provisioning ─▶ running ─▶ verifying ─▶ pr_opened ─▶ completed
                            │  ▲         │
                            ▼  │         └─▶ running (one escalated retry)
                          blocked ─▶ provisioning (future resume)
every non-terminal state ─▶ failed
```

### Runtime

The runtime is Node 24's built-in TypeScript type stripping with `node:test`, and there are no runtime dependencies. The only dev dependencies are `typescript` and `@types/node`, used for `tsc --noEmit`. The existing `skills/poteto-mode/scripts` tools use Bun, but Bun is not installed on this machine, and the worker needs no TypeScript runtime at all. The code keeps the existing style: strict TS, readonly interfaces, discriminated unions, and injected fakes in tests.

### Task setup and worker hardening (T13, T14)

- **Toolchain.** A task can declare `packages` and `setup`. `packages` are Amazon Linux package names that root installs with `dnf` in `prepare`. The names are validated, so they cannot inject shell. `setup` holds commands that run as the task user in the repo at the end of `prepare`, for example a Node tarball into `~/.local` or `npm ci`. `~/.local/bin` is on the task user's `PATH` in every phase. `--volume-gb` (default 20) sets an encrypted gp3 root volume that is deleted on termination, because the image's 8 GB is too small for real builds.
- **Task user.** Root runs only controller-rendered steps: base tools, packages, the agent CLI, the clone, and publishing. Everything the task defines runs as the unprivileged `factory-task`: `setup`, `change`, `verify`, and the diff that `publish` reads. It runs through `setpriv` with a clean environment of `HOME`, `PATH`, and `LANG`, plus the agent key during `change` only.
- **IMDS.** An nftables rule rejects `169.254.169.254` and `fd00:ec2::254` for the task uid, so task code cannot get instance role credentials. `prepare` fails if the task user can still reach IMDS.
- **Crossing the boundary.** Root clones into `clone/`, copies it to `task/repo`, and hands `task/` to the task user before any task code runs. Data flows back only as stdout of a process that runs as the task user: the blocked signal and a binary patch against the base commit. Root never runs git in the task's repo. Instead, `publish` applies the patch to its own clone and pushes from there. This keeps a planted hook or `.git/config` entry (such as `core.fsmonitor`) from running as root next to the GitHub token.
- **Script transport.** SSM writes each phase script to a `mktemp` file owned by root. It no longer uses a fixed `/tmp` path that the task user could create first.
- **Local worker.** It renders the same scripts. There, `factory_task` is plain `bash` as the operator, so the local worker gives no isolation.

### First real app: benchmark scaffold (T16)

The benchmark app is a deliberately small task tracker. It tests the factory workflow, not application complexity. T16 only creates the repo and scaffolds it. It adds no product features, and it does not decide persistence, auth, or hosting. Those belong to the later planning phase (product brief, requirements, architecture, acceptance tests, task graph, Human Gate #1).

- **Repo.** `olibyte/agent-factory-benchmark`, public, created with `gh repo create --public --add-readme`. The README commit gives the worker a `main` to clone. The app repo holds no factory code: the controller, the task files, and run records stay in agent-toolkit.
- **Token.** The worker's fine-grained token (`/agent-factory/github-token`) gets the new repo added under "Only select repositories". Its permissions (Contents and Pull requests, read and write) and its value stay the same, so SSM needs no change. Only the operator can do this, in the GitHub web UI.
- **Task.** `.factory/tasks/benchmark-scaffold.task.json`, one run, one PR. `packages` and `setup` declare the toolchain: `tar` and `xz`, and Node 24.18.0 in `~/.local`. It does not rely on the Node that the worker installs for the agent CLI. `setup` cannot run `npm ci`, because `package.json` does not exist until the change phase. The change is a Claude Code agent (`sonnet`, with an `opus` retry) that follows exact, pinned commands. The factory's real-app tasks will be agent tasks, so the scaffold uses that path too, and the deterministic verify list is what makes the result trustworthy. The run uses a `t3.medium`, because `next build` can exhaust the 2 GiB of a `t3.small`.
- **Scaffold scope.** `create-next-app@16.3.6` with TypeScript, Tailwind CSS, ESLint, App Router, no `src/`, the `@/*` alias, npm, and `AGENTS.md`. It generates into a temp dir and is copied in, because it refuses a folder that holds `README.md`. Its `.gitignore` therefore lands before any install. Node 24 comes from `engines`, `.nvmrc`, and `@types/node@^24`. Tests use Vitest with React Testing Library, as the Next.js App Router testing guide describes, plus one smoke test for the home page. The demo page becomes a one-heading placeholder. There is no CI workflow (it would need the token's Workflows permission), and there is no Docker, database, auth, or env file.
- **Skills, pinned.** The skills CLI is pinned to `skills@1.7.0`, and every source is a GitHub tree URL at a commit. The CLI records that commit as `ref` in `skills-lock.json`, with a content hash for each skill. All sources install for claude-code, cursor, codex, antigravity, and antigravity-cli, in `.agents/skills/` with symlinks in `.claude/skills/`, all committed.
  - agent-toolkit at `3a69c94` (main after #9): the 15 default skills. `AGENTS.md` joins the toolkit template (from the same commit) with create-next-app's `nextjs-agent-rules` block. `CLAUDE.md` is `@AGENTS.md`.
  - `vercel-labs/agent-skills` at `063bee9`: `vercel-react-best-practices`, `vercel-composition-patterns`, and `web-design-guidelines`. The deploy, Vercel CLI, and optimize skills wait for the hosting decision, and React Native does not apply.
  - `vercel/next.js` at the `v16.3.6` tag (`a758ffc`), matching the installed Next.js: 4 skills, including `next-dev-loop`.
  - To update a source, rerun its `add` command with a new commit.
  - The skills ship their own TypeScript scripts and Bun tests. ESLint, Vitest, and `tsconfig.json` exclude `.agents/` and `.claude/`. Without that, `npm run lint` and `npm test` fail on vendored files.
- **Verify.** It checks Node 24, then runs `npm ci`, `npm run lint`, `npm run build`, and `npm test`. Vitest exits non-zero when it finds no test files. It checks that `node_modules`, `.next`, and `next-env.d.ts` are ignored, and that `git status` shows nothing under them. Verify runs in the task repo that `publish` diffs, so an unignored build folder would land in the PR. It also checks that `skills-lock.json` holds exactly the 22 pinned skills at their commits, that skill files resolve through `.claude/skills`, and the contents of `AGENTS.md`, `CLAUDE.md`, and `package.json`.
- **Checked before the run.** On the operator's Mac (Node 24.18.0, npm 11.16.0), the generate-and-copy scaffold passed all 14 verify commands from a clean `node_modules`. All three pinned skill installs worked, and a patch that adds the skill symlinks applied cleanly with `git apply --index`.

## Reuse

- **`gh` and `aws` CLIs** instead of SDKs. This matches `watch-pr/github.ts`, which already shells out to `gh`.
- **`handoff` skill.** `.factory/handoff.md` follows the same approach of reconstructing from files. The root `AGENTS.md` points every harness at it.
- **`watch-pr` (poteto-mode).** It is the follow-up tool for babysitting a PR after `pr.opened`, so the factory does not duplicate CI or review polling.
- **AL2023 image features.** The preinstalled SSM agent and AWS CLI remove the need for a bootstrap AMI.
- Not reused: `orch/store.ts`. It is a 1.6k-line multi-unit ledger for a different domain, and one run's state is about 150 lines.

## Tasks

| id | task | depends on |
| --- | --- | --- |
| T1 | Scaffold `factory/` package: tsconfig, test runner, shell and exec helpers | – |
| T2 | `task-state/`: machine, file store, state-change events, tests | T1 |
| T3 | `notifications/`: event union, notifier interface, console, Slack webhook, fanout, tests | T1 |
| T4 | `github/`: publish script (idempotent branch, commit, push, PR, auto-merge), PR metadata parser, tests with a fake `gh` and a bare origin | T1 |
| T5 | `worker/`: provider interface, phase scripts, local provider, tests | T4 |
| T6 | Orchestrator and CLI (`run`, `status`, `cleanup`), handoff block, tests | T2, T3, T5 |
| T7 | Local end-to-end run against a sandbox GitHub repo (real PR) | T6, sandbox repo |
| T8 | `worker/ec2.ts`: launch, SSM wait, send-command, terminate, tests with a fake `aws` | T5 |
| T9 | `infra/` Terraform and setup docs (replaced the first CloudFormation draft) | – |
| T12 | AWS account: Identity Center, factory member account, `agent-factory` profile (user) | – |
| T10 | EC2 end-to-end proof | T8, T9, T12, Slack webhook, token in SSM |
| T11 | Codex review, docs, handoff | all |
| T13 | Task `packages` and `setup`, `--volume-gb` | – |
| T14 | Task user, IMDS block, patch-based publish, root-only script files | – |
| T15 | Agent (Claude Code) proof on EC2 against the sandbox | T13, T14 |
| T16 | Benchmark repo, worker token access, scaffold through the factory on EC2 | T15, token grant (user) |

## Out of scope

SQS, Kubernetes, dashboard, interactive Slack, multi-region, autoscaling, scheduler, and the task tracker. Resuming a blocked run is also out: the machine allows `blocked → provisioning`, but no command drives it yet.
