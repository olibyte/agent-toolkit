# Factory v0

Runs one software task on an ephemeral worker and ends with a GitHub pull request. The worker clones a repo, makes the change, runs verification, pushes a branch, and opens the PR. The controller sends notifications, terminates the worker, and records the run in `.factory/`.

The controller is TypeScript on Node 24 with no runtime dependencies. The worker only runs bash scripts that the controller renders: `prepare`, `change`, `verify`, and `publish`. EC2 workers receive them over SSM Run Command, so there is no SSH and no inbound port. The design and its trade-offs are in [`.factory/plan.md`](../.factory/plan.md).

| Directory | Contents |
| --- | --- |
| `task-state/` | Run state machine and the run store |
| `notifications/` | Event types, notifier interface, Slack Incoming Webhook adapter |
| `github/` | Checkout and publish scripts (branch, commit, push, PR, auto-merge) and PR metadata parsing |
| `worker/` | Provider interface, phase scripts, `local` and `ec2` providers |
| `orchestrator.ts`, `cli.ts` | Run driver and command line |
| `infra/` | Terraform for the worker role, instance profile, security group, and an optional budget |

## Requirements

- Node 22.18 or later (24 recommended), `git`, and `gh` logged in.
- For EC2 workers: AWS CLI v2 and Terraform 1.6 or later.

```bash
cd factory && npm install && npm run check   # tsc --noEmit plus node --test
```

## Task file

```json
{
  "repo": "owner/name",
  "base": "main",
  "title": "PR title and commit subject",
  "body": "PR body (defaults to the title)",
  "packages": ["python3.12"],
  "setup": ["npm ci"],
  "change": { "kind": "shell", "run": "echo hi > HELLO.md" },
  "verify": ["test -s HELLO.md"],
  "autoMerge": false
}
```

- `packages` (optional) lists Amazon Linux packages that root installs with `dnf` before the clone. The local worker skips them.
- `setup` (optional) lists commands that run in the repo after the clone and before the change, for example a toolchain or `npm ci`. Tools installed under `~/.local` stay on `PATH` for later phases. [`examples/toolchain.task.json`](examples/toolchain.task.json) installs Node from the official tarball this way.
- `change.kind: "agent"` runs a coding agent instead: `{ "kind": "agent", "harness": "claude-code" | "codex", "prompt": "...", "model"?: "...", "escalationModel"?: "..." }`. Claude Code defaults to `sonnet`, a cost-efficient model. Codex uses its own default. When `escalationModel` is set, a failed verification gets exactly one retry on that model, with the failing output added to the prompt.
- An agent that needs a human writes `{"status":"blocked","reason":"...","question":"..."}` to `$FACTORY_SIGNAL_FILE`. The run then ends in `blocked` and the worker is released.
- Every task command receives `FACTORY_RUN_ID` and `FACTORY_BRANCH`. The branch is `factory/<run-id>`.
- With `autoMerge: true`, the run calls `gh pr merge --auto --squash`. The repo must allow auto-merge. If it does not, the run logs a warning and still completes.

Examples: [`examples/proof.task.json`](examples/proof.task.json), [`examples/agent.task.json`](examples/agent.task.json), and [`examples/toolchain.task.json`](examples/toolchain.task.json) (EC2 only).

## Run

From the repo root:

```bash
node factory/cli.ts run factory/examples/proof.task.json --worker local      # temp dir on this machine
node factory/cli.ts run factory/examples/proof.task.json --worker ec2
node factory/cli.ts status [run-id]
node factory/cli.ts cleanup <run-id>      # terminate a leftover worker, fail an unfinished run
```

Exit codes: `0` completed, `1` failed, `2` usage error, `3` blocked. The final run record goes to stdout, and progress goes to stderr.

Everything a run writes stays under `.factory/runs/`, which is gitignored. Run history belongs to whoever ran it, not to the repo.

- `.factory/runs/state.json`: every run's task, state history, worker, PR metadata, and error.
- `.factory/runs/last-run.md`: a readable summary of the latest run, for the next agent or person.
- `.factory/runs/<id>/`: phase logs and `events.jsonl`.

The local worker runs every task command as you, on your machine, with agent permission prompts disabled. It has none of the EC2 worker's isolation. Use it for shell tasks, or for agents you already trust there.

## EC2 setup

### AWS access

Run the factory in its own AWS account with short-lived credentials. Never use root access keys.

1. Sign in as root once. Turn on MFA, and do not create root access keys.
2. Enable IAM Identity Center. This also creates an AWS Organization. Then create a member account for the factory, for example `agent-factory` with a plus-address email such as `you+agent-factory@gmail.com`.
3. In Identity Center, create a user for yourself and give it the `AdministratorAccess` permission set on the factory account. A 12-hour session length keeps logins to about one a day.
4. Locally, run `aws configure sso --profile agent-factory` and choose your worker region. Run `aws sso login --profile agent-factory` whenever the session expires.
5. Add `export FACTORY_AWS_PROFILE=agent-factory` to `~/.zshenv`. Only factory commands read it, so other tools keep their own AWS settings.

The separate account keeps agent-launched instances, IAM roles, and spend away from everything else. You can close the account to remove it all.

### Deploy

1. Create the worker resources. They cost nothing while idle.

   ```bash
   brew tap hashicorp/tap && brew install hashicorp/tap/terraform
   cp factory/infra/terraform.tfvars.example factory/infra/terraform.tfvars   # region, profile, budget email
   terraform -chdir=factory/infra init
   terraform -chdir=factory/infra apply
   ```

   This creates `agent-factory-worker` (role and instance profile) and an egress-only security group of the same name in the default VPC. If `budget_alert_email` is set, it also creates a monthly account budget. The CLI finds these resources by name, so no IDs are copied by hand. Terraform state stays local in `factory/infra/terraform.tfstate`, which is gitignored. Move it to an S3 backend before a second person applies.

2. Store a GitHub token for the worker. Use a fine-grained token limited to the target repo, with **Contents: read and write** and **Pull requests: read and write**. Terraform never sees the token, so it stays out of state.

   ```bash
   read -rs GH_WORKER_TOKEN && aws ssm put-parameter --profile agent-factory --name /agent-factory/github-token \
     --type SecureString --value "$GH_WORKER_TOKEN" && unset GH_WORKER_TOKEN
   ```

   Agent tasks also read `/agent-factory/anthropic-api-key` or `/agent-factory/openai-api-key` when those parameters exist.

3. Create a Slack Incoming Webhook and export it in `~/.zshenv`. Never commit it.

   ```bash
   export FACTORY_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
   ```

4. Run with `--worker ec2`. The region comes from `--region`, `AWS_REGION`, or the profile. A trivial run takes a few minutes on a `t3.small`. `--instance-type t4g.small` picks the arm64 image. `--volume-gb` sets the encrypted gp3 root volume, which defaults to 20 GiB.

The controller's credentials need `ec2:DescribeSecurityGroups`, `ec2:RunInstances`, `ec2:CreateTags`, `ec2:DescribeInstances`, `ec2:TerminateInstances`, `iam:PassRole` on the worker role, `ssm:SendCommand`, `ssm:GetCommandInvocation`, and `ssm:DescribeInstanceInformation`.

### What protects the account

- The worker has no key pair and no inbound rules, and IMDSv2 is required. It reaches GitHub and SSM through egress only.
- The worker role has `AmazonSSMManagedInstanceCore`, plus `ssm:GetParameter` on `/agent-factory/*`. An explicit Deny blocks every other parameter.
- Secrets never appear in user-data, SSM command parameters, state, or logs. The Slack webhook never leaves the controller.
- Everything the task defines (`setup`, `change`, `verify`) runs as the unprivileged user `factory-task`, with an environment that holds only `HOME`, `PATH`, `LANG`, and the git config. An nftables rule blocks that user from instance metadata, so task code cannot get the instance role's credentials or read `/agent-factory/*`. `prepare` fails if the block is not in place.
- Only root reads the GitHub token, in `prepare` and `publish`. The agent's API key is passed to the task user only in `change`, because the agent needs it.
- Root never runs git in the task's repo, so a hook or `.git/config` entry that the task plants cannot run next to the token. `publish` reads a patch from the task user and applies it to root's own clone of the base commit, then pushes from that clone.
- User-data schedules `shutdown -h +90` with shutdown behavior `terminate`. If the controller dies, the instance still ends within 90 minutes. Ctrl-C runs cleanup, and `cleanup <run-id>` covers anything left over.
- To find stray workers: `aws ec2 describe-instances --filters Name=tag-key,Values=agent-factory:run Name=instance-state-name,Values=pending,running`.

Teardown: `terraform -chdir=factory/infra destroy`, then `aws ssm delete-parameter --profile agent-factory --name /agent-factory/github-token`.

## Events

`notifications/events.ts` defines these events: `factory.started`, `factory.completed` (with outcome `completed`, `failed`, or `blocked`), `worker.started`, `worker.failed`, `agent.blocked`, `agent.question`, `pr.opened`, `pr.merged`, `deploy.failed`, and `deploy.succeeded`. The two deploy events have no emitter yet. A new sink implements `Notifier.notify(event)`. The fanout wrapper logs a failing sink and never fails a run.
