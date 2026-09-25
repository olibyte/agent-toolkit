# Factory v0

Runs one software task on an ephemeral worker and ends with a GitHub pull request. The worker clones a repo, makes the change, runs verification, pushes a branch, and opens the PR. The controller sends notifications, terminates the worker, and records the run in `.factory/`.

The controller is TypeScript on Node 24 with no runtime dependencies. The worker only runs bash scripts that the controller renders: `prepare`, `change`, `verify`, and `publish`. EC2 workers receive them over SSM Run Command, so there is no SSH and no inbound port. The design and its trade-offs are in [`.factory/plan.md`](../.factory/plan.md).

| Directory | Contents |
| --- | --- |
| `task-state/` | Run state machine and the `.factory/state.json` store |
| `notifications/` | Event types, notifier interface, Slack Incoming Webhook adapter |
| `github/` | Checkout and publish scripts (branch, commit, push, PR, auto-merge) and PR metadata parsing |
| `worker/` | Provider interface, phase scripts, `local` and `ec2` providers |
| `orchestrator.ts`, `cli.ts` | Run driver and command line |
| `infra/worker.yaml` | CloudFormation for the worker role, instance profile, and security group |

## Requirements

- Node 22.18 or later (24 recommended), `git`, and `gh` logged in.
- For EC2 workers: AWS CLI v2 with credentials for the target account.

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
  "change": { "kind": "shell", "run": "echo hi > HELLO.md" },
  "verify": ["test -s HELLO.md"],
  "autoMerge": false
}
```

- `change.kind: "agent"` runs a coding agent instead: `{ "kind": "agent", "harness": "claude-code" | "codex", "prompt": "...", "model"?: "...", "escalationModel"?: "..." }`. Claude Code defaults to `sonnet`, a cost-efficient model. Codex uses its own default. When `escalationModel` is set, a failed verification gets exactly one retry on that model, with the failing output added to the prompt.
- An agent that needs a human writes `{"status":"blocked","reason":"...","question":"..."}` to `$FACTORY_SIGNAL_FILE`. The run then ends in `blocked` and the worker is released.
- Every phase receives `FACTORY_RUN_ID` and `FACTORY_BRANCH`. The branch is `factory/<run-id>`.
- With `autoMerge: true`, the run calls `gh pr merge --auto --squash`. The repo must allow auto-merge. If it does not, the run logs a warning and still completes.

Examples: [`examples/proof.task.json`](examples/proof.task.json) and [`examples/agent.task.json`](examples/agent.task.json).

## Run

From the repo root:

```bash
node factory/cli.ts run factory/examples/proof.task.json --worker local      # temp dir on this machine
node factory/cli.ts run factory/examples/proof.task.json --worker ec2 --region us-east-1
node factory/cli.ts status [run-id]
node factory/cli.ts cleanup <run-id>      # terminate a leftover worker, fail an unfinished run
```

Exit codes: `0` completed, `1` failed, `2` usage error, `3` blocked. The final run record goes to stdout, and progress goes to stderr. Each run writes:

- `.factory/state.json` (committed): task, state history, worker, PR metadata, and error.
- `.factory/runs/<id>/` (gitignored): phase logs and `events.jsonl`.
- The "Last factory run" block in `.factory/handoff.md`.

The local worker runs agent tasks with permission prompts disabled, on your machine. Use it for shell tasks, or for agents you already trust there.

## EC2 setup

1. Deploy the worker stack into the default VPC. The stack contains no instances, so it costs nothing while idle.

   ```bash
   export AWS_REGION=us-east-1
   VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
   aws cloudformation deploy --stack-name agent-factory --template-file factory/infra/worker.yaml \
     --parameter-overrides VpcId="$VPC" --capabilities CAPABILITY_IAM
   ```

2. Store a GitHub token for the worker. Use a fine-grained token limited to the target repo, with **Contents: read and write** and **Pull requests: read and write**.

   ```bash
   read -rs GH_WORKER_TOKEN && aws ssm put-parameter --name /agent-factory/github-token \
     --type SecureString --value "$GH_WORKER_TOKEN" && unset GH_WORKER_TOKEN
   ```

   Agent tasks also read `/agent-factory/anthropic-api-key` or `/agent-factory/openai-api-key` when those parameters exist.

3. Create a Slack Incoming Webhook and export it in the controller's shell. Never commit it.

   ```bash
   export FACTORY_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
   ```

4. Run with `--worker ec2`. A trivial run takes a few minutes on a `t3.small`. `--instance-type t4g.small` picks the arm64 image.

The controller's credentials need `cloudformation:DescribeStacks`, `ec2:RunInstances`, `ec2:CreateTags`, `ec2:DescribeInstances`, `ec2:TerminateInstances`, `iam:PassRole` on the worker role, `ssm:SendCommand`, `ssm:GetCommandInvocation`, and `ssm:DescribeInstanceInformation`.

### What protects the account

- The worker has no key pair and no inbound rules, and IMDSv2 is required. It reaches GitHub and SSM through egress only.
- The worker role has `AmazonSSMManagedInstanceCore`, plus `ssm:GetParameter` on `/agent-factory/*`. An explicit Deny blocks every other parameter.
- Secrets never appear in user-data, SSM command parameters, state, or logs. The Slack webhook never leaves the controller.
- Only `prepare` and `publish` see the GitHub token. The task's `change` and `verify` commands run with it unset. Agent API keys are exported only in `change`, because the agent needs them.
- Known limit: task code runs as root, so it can still use the instance role to read `/agent-factory/*`. Keep the GitHub token scoped to one sandbox repo until tasks run as an unprivileged user with IMDS blocked (the next hardening step).
- User-data schedules `shutdown -h +90` with shutdown behavior `terminate`. If the controller dies, the instance still ends within 90 minutes. Ctrl-C runs cleanup, and `cleanup <run-id>` covers anything left over.
- To find stray workers: `aws ec2 describe-instances --filters Name=tag-key,Values=agent-factory:run Name=instance-state-name,Values=pending,running`.

Teardown: `aws cloudformation delete-stack --stack-name agent-factory && aws ssm delete-parameter --name /agent-factory/github-token`.

## Events

`notifications/events.ts` defines these events: `factory.started`, `factory.completed` (with outcome `completed`, `failed`, or `blocked`), `worker.started`, `worker.failed`, `agent.blocked`, `agent.question`, `pr.opened`, `pr.merged`, `deploy.failed`, and `deploy.succeeded`. The two deploy events have no emitter yet. A new sink implements `Notifier.notify(event)`. The fanout wrapper logs a failing sink and never fails a run.
