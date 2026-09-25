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
│ .factory/state.json, handoff.md       │  stdout  └──────────────────────────┘
└───────────────────────────────────────┘
```

- **Controller renders, worker runs shell.** Each phase is a bash script the controller renders and sends. The worker needs git and gh, plus an agent CLI only for `agent` tasks. The worker never runs factory TypeScript. One mechanism drives both the local and the EC2 worker.
- **One SSM command per phase.** State transitions then match real progress (`provisioning` covers launch, SSM registration, and clone; `running` covers the change; `verifying` covers verification and publishing). Each phase prints a log tail and one `::factory-result::<json>` line. This keeps output under the 24 KB SSM stdout limit.
- **Secrets.** The worker's GitHub token (and agent API keys) are SecureString parameters under `/agent-factory/`. The worker reads them with its instance role. An explicit Deny blocks every other parameter. The Slack webhook stays on the controller in `FACTORY_SLACK_WEBHOOK_URL`. Secrets never appear in user-data, SSM command parameters, state, or logs.
- **Ephemeral worker.** The worker is Amazon Linux 2023, which ships with the SSM agent and the AWS CLI. It has IMDSv2, no key pair, and a security group with no inbound rules. It uses the default VPC's public subnet for egress. User-data only sets `shutdown -h +90` with shutdown behavior `terminate`, so a crashed controller still cannot leak an instance for long. The orchestrator terminates the worker in a `finally` block and waits for `terminated`.
- **Infra.** One CloudFormation stack (`factory/infra/worker.yaml`) holds the role, the instance profile, and the security group. The controller reads its outputs, so no IDs are copied by hand. `delete-stack` removes everything.
- **State.** `.factory/state.json` (committed) keeps one record per run: task, state, transition history, worker ref, PR metadata, and error. Per-run phase logs and the event JSONL go to `.factory/runs/<id>/`, which is gitignored. `.factory/handoff.md` has hand-written sections plus a generated "Last factory run" block.
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
| T9 | `infra/worker.yaml` and setup docs | – |
| T10 | EC2 end-to-end proof | T8, T9, AWS creds, Slack webhook, token in SSM |
| T11 | Codex review, docs, handoff | all |

## Out of scope

SQS, Kubernetes, dashboard, interactive Slack, multi-region, autoscaling, scheduler, and the task tracker. Resuming a blocked run is also out: the machine allows `blocked → provisioning`, but no command drives it yet.
