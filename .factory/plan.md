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

### Benchmark CI workflow (T19)

The benchmark repo gets one GitHub Actions workflow. It runs on every PR and on every push to `main`, so later factory PRs get an independent check from GitHub as well as the worker's own verify.

- **Workflow.** `.github/workflows/ci.yml`, named `CI`, with one job, `check`, on `ubuntu-24.04` with a 15-minute limit. The job runs the same four commands as the scaffold's verify: `npm ci --no-audit --no-fund`, `npm run lint`, `npm run build`, and `npm test`. `NEXT_TELEMETRY_DISABLED=1` is set. `permissions: contents: read`, and checkout uses `persist-credentials: false`. A concurrency group cancels superseded runs on the same ref. There is no deploy step, no secrets, no matrix, and no branch protection. Requiring the check before merge is a separate decision for the operator.
- **Pins.** Actions are pinned to full commit SHAs, with the tag as a comment: `actions/checkout` v7.0.1 (`3d3c42e`) and `actions/setup-node` v7.0.0 (`8207627`). Node comes from `.nvmrc` (24), so CI and the worker use the same major version.
- **Token.** Pushing a file under `.github/workflows/` needs the worker token's **Workflows: Read and write** permission. Only the operator can add it, in the GitHub web UI. GitHub rejects the push without it, so a missing grant shows up in `publish`.
- **Task.** `.factory/tasks/benchmark-ci.task.json`, one run, one PR. It is a Claude Code agent task with an exact spec, like T16. `packages` adds `python3-pyyaml`. `setup` installs Node 24.18.0 and actionlint 1.7.12 into `~/.local`, and checks actionlint's release SHA-256 first.
- **Verify.** It checks that the only change is `.github/workflows/ci.yml`, that actionlint passes, and that every `uses:` is a 40-character SHA with a version comment. A PyYAML assertion checks the triggers, the permissions, the checkout and setup-node settings, the four commands in order, and the time limit. Then it runs the same four commands on the worker.
- **Real proof.** The PR that the run opens triggers the workflow itself, from a branch in the same repo. T19 is done when that check passes on the PR and again on `main` after the merge.
- **Checked before the run.** The intended workflow passed actionlint 1.7.12 on the operator's Mac, and the verify list passed against a clone of the benchmark's `main`.

### Benchmark product brief (T20)

The planning phase starts from a short product intent, not a formal brief written by the operator. The factory expands the intent into `docs/product-brief.md` in the benchmark repo. The next planning steps (requirements, architecture, data model, API and security decisions, acceptance tests, the task graph) build on that file, and Human Gate #1 answers its open questions.

- **Product intent.** This is the operator's intent, given with T16. It is the committed source, and the task prompt carries a copy of it, because the worker clones only the benchmark repo:
  > A deliberately small task/issue tracker. The product is intentionally simple because the main thing being tested is the autonomous software-factory workflow, not application complexity. The eventual application should allow an authenticated user to: create projects; create, edit and delete tasks; give tasks a status: Todo, In Progress, Done; assign a priority; filter tasks by status and priority; see a small dashboard/summary. Target user: an individual or small team managing simple software/project tasks.
- **Where planning docs live.** In the benchmark repo under `docs/`, one file per planning step, each through its own factory task and PR. They describe the app, so they version with it. The factory's own coordination stays in agent-toolkit.
- **Open details.** The intent leaves some product details open: priority levels, team sharing, what the dashboard shows, and what deleting a project does. None of them blocks the brief. The agent picks the simplest option, writes it under Assumptions, and lists the ones that change scope under Open questions for Human Gate #1. The operator is only asked earlier if a gap stops the brief being written at all.
- **Boundaries.** The brief says what the product does and for whom. It names no database, ORM, auth library or protocol, hosting platform, or cloud service. Those decisions become open questions. It mentions the fixed scaffold stack once, under Constraints. v1 scope is the six capabilities in the intent, and everything else goes under Non-goals.
- **Task.** `.factory/tasks/benchmark-product-brief.task.json`, one run, one PR. It is a Claude Code agent task (`sonnet`, with an `opus` retry). It needs no `packages` or `setup`, because it writes one Markdown file and the checks use the worker's `python3`. A `t3.small` is enough, because nothing is built.
- **Verify.** Four commands. The only change is `docs/product-brief.md`. The title and the nine `##` headings match exactly and in order, the length is 500 to 1400 words, and there are no placeholders or emoji. Scope names the three statuses exactly, plus projects, create, edit, delete, priority, filters, and the dashboard, and no assignees, due dates, attachments, or notifications. The Summary names Factory v0 and agent-toolkit, the brief covers sign-in, Success criteria has at least 5 bullets, Assumptions has at least 3, and Open questions has 3 to 8 bullets that all end with `?`. A deny list rejects named databases, auth providers and protocols, clouds, and hosting platforms. The quality of the writing is for the operator to judge in the PR.
- **Checked before the run.** Against a clone of the benchmark's `main`, a sample brief passed all four commands. Seven mutations each failed the command meant to catch them: an extra changed file, a renamed heading, a placeholder, different status names, an assignee in Scope, a named database, and a question without `?`.

### Benchmark requirements (T21)

The second planning step turns `docs/product-brief.md` into `docs/requirements.md` in the benchmark repo. Later steps cite requirements by ID: the acceptance tests check them, and the task graph splits them into build tasks. So the IDs and their format are the interface, and the verify commands check them strictly.

- **Source.** The merged brief only, with no wider scope. Where the brief conflicts with itself, the Assumptions win. Its Target users mentions a small team, but its Assumptions make each project belong to one user with one kind of account, so the requirements are single-owner. The brief's Scope creates, lists, and opens projects but never renames or deletes them, so those go under Out of scope. The brief's cascade assumption applies if project deletion is added later.
- **Format.** Each requirement is a one-line bullet, `- **FR-01** ...` or `- **NFR-01** ...`, numbered in order with no gaps, and each says what the app must do in a way an automated test could check. There are 12 to 30 functional requirements, grouped under Access, Projects, Tasks, Status and priority, Filtering, and Dashboard. There are 4 to 10 non-functional ones: access control, input validation, accessibility, error and empty states, and testability. A Traceability table maps each of the brief's success criteria (`SC-1` onwards, in order) to the requirements that satisfy it.
- **Open details.** Where a requirement needs something the brief leaves open, such as length limits, list order, or empty states, the agent picks the simplest option, writes it into the requirement, and lists it under Assumptions. The open questions carry over the brief's questions that are still open, merge its two sharing questions, and add sign-in method and account deletion. Each question names the requirement IDs its answer would change.
- **Boundaries.** Same as the brief: no database, ORM, auth library or protocol, hosting platform, or cloud service. The sign-in method is left to the security decisions step, so passwords, passkeys, magic links, SSO, and MFA are not named either.
- **Task.** `.factory/tasks/benchmark-requirements.task.json`, one run, one PR, on a `t3.small`. Claude Code runs on `sonnet` with an `opus` retry, and needs no `packages` or `setup`.
- **Verify.** Five commands. The only change is `docs/requirements.md`. The headings match exactly and in order, with a blank line after each one, and there are 800 to 2400 words with no placeholders or emoji. IDs are sequential and in range, every bullet in the two requirement sections is a requirement that says "must", and every ID the document cites exists. The Traceability table has one row per bullet in the brief's Success criteria, read from the brief itself, and each row names a requirement. The functional requirements name the three statuses, the three priorities, and sign-in, and nothing from the brief's Non-goals. There are at least 2 assumptions, and 3 to 8 open questions that each cite an ID and end with `?`. A deny list covers the brief's list plus sign-in methods.
- **Checked before the run.** Against a clone of the benchmark's `main`, a sample document (1095 words) passed all five commands. Eleven mutations each failed only the command meant to catch them: an extra file, an edited brief, a missing blank line, an ID gap, a requirement without "must", a stray bullet, an unknown ID, a missing traceability row, an assignee in the requirements, a question without an ID, and a named sign-in method.

### Benchmark requirements with the operator's answers (T22)

The operator answered T21's open questions on 2026-09-27, before merging it. They also set a rule of thumb for later product questions: use Trello, or a very basic, dialled-down Jira, as the north star.

- **Answers.** Projects are shared. When project deletion is added, the app warns the user first. Three priority levels are enough. Project names need not be unique. A sign-up flow is required. The sign-in method is the factory's call for an MVP. A signed-in user can delete their own account.
- **Calls made from those answers** (Trello-like, as small as possible):
  - Accounts use an email address and a password. The email is unique regardless of case, the password is at least 8 characters, and sign-up signs the user in. There is no email verification and no password reset, because both need email delivery. Sign-in failures say only that the email or password is wrong.
  - Sharing: whoever creates a project owns it. The owner adds members by the email of an existing account and can remove them. Members can do everything with tasks, but only the owner manages members. Owner and member are the only roles. There are no invitations to people without an account, no leaving, and no ownership transfer.
  - Deleting an account needs the password. It removes the user from other people's projects and deletes the projects they own, with those projects' tasks, after a warning that names them. Project deletion itself stays out of v1.
  - Priority can be chosen when a task is created, and defaults to Medium.
- **Where the answers live.** In a new `## Decisions` section of `docs/requirements.md`, which also records the north star. The brief keeps its original assumptions, and the Overview says the Decisions override the brief where they differ. Later factory tasks clone only the benchmark repo, so the rule must be written there to reach them.
- **Task.** `.factory/tasks/benchmark-requirements-decisions.task.json`. `main` doesn't have the T21 draft yet, so `setup` downloads it from #4's head commit (`921dd4b`) into the working tree, and the agent revises it in place. The run opens one PR that replaces #4. The agent also fixes the review notes: overlapping requirements, sign-out, a description length limit, the task-list order, and the stray citation. IDs are renumbered, because nothing cites them yet.
- **Verify.** Still five commands, adjusted from T21. The headings add Decisions. There are 1000 to 3000 words and 20 to 40 functional requirements. The functional requirements must cover sign-up, sign-in, sign-out, account deletion, and members. Decisions has at least 7 bullets, each citing an ID, and names the north star. Open questions shrink to 0 to 5. The deny list no longer blocks "password", but still blocks every other sign-in method, provider, and library.
- **Checked before the run.** On a clean clone of `main`, `setup` downloaded the draft (99 lines), and the unrevised draft failed the headings and sign-up checks as it should. A revised sample (1350 words, 28 functional requirements) passed all five commands. Ten mutations each failed: no Decisions section, a decision with no ID, no north star, no sign-up, no account deletion, no sign-out, a hashing algorithm named, another sign-in method named, 6 open questions, and 19 functional requirements. The first sample showed that the Decisions check required "sign in" spelled exactly, so it now accepts "sign-in" too.

### Benchmark architecture (T23)

The third planning step turns the merged brief and requirements (#5, `08fa0a7`) into `docs/architecture.md`. The later steps (data model, API and security decisions, acceptance tests, task graph) cite its decisions as `AD-01` onwards, so, as with the requirements, the IDs and their format are the interface.

- **Calls made here, from facts the agent can't see.** CI has no database service or secrets, and the factory worker is Amazon Linux 2023 with no Docker and no browsers. Both run `npm ci`, lint, build, and test. So persistence is SQLite in a local file, tests run in Vitest with no browser end-to-end tests, and no hosted service is needed at runtime. Deployment and hosting are out of scope, and the agent raises them as an open question for Human Gate #1. npm 11.16 skips a package's install scripts unless `package.json` approves them (`allowScripts`), which matters for native modules. Node 24's built-in `node:sqlite` works without a flag.
- **Left to the agent**, each with a reason: the SQLite driver and data-access layer, a maintained auth library or a small session implementation of its own, Server Actions or Route Handlers, where access checks sit, and the module layout. The agent reads the Next.js 16 guides in `node_modules/next/dist/docs/` first, so `setup` installs Node 24 and runs `npm ci`. Tables and columns belong to the data model step. Session lifetime, cookie settings, hashing parameters, and rate limits belong to the security step.
- **Format.** There are 6 to 15 one-line decisions, `- **AD-01** ...`, and each cites the requirements it serves. A Requirement coverage table lists every FR and NFR individually, with the decisions that meet it. A Dependencies table lists each new npm package with its purpose and decision.
- **Task.** `.factory/tasks/benchmark-architecture.task.json`, one run, one PR, on a `t3.small`. Claude Code runs on `sonnet` with an `opus` retry.
- **Verify.** Six commands:
  1. The only change is `docs/architecture.md`.
  2. The headings are exact and in order, with a blank line after each one, 1200 to 3500 words, and no placeholders or emoji. Code blocks are ignored when finding headings.
  3. Decision IDs are sequential and each one cites a requirement. Every cited FR, NFR, or AD exists, and the coverage table covers exactly the requirement IDs in `docs/requirements.md`.
  4. The content covers:
     - **Decisions:** SQLite, sessions, passwords, Vitest, and Server Actions or Route Handlers.
     - **Constraints:** Node 24 and Amazon Linux.
     - **Request flow:** cites NFR-01.
     - **Testing:** names `npm test` and NFR-05.
     - **Module layout:** a code block.
     - **Other sections:** deployment is raised, there are at least 2 assumptions, and there are 1 to 6 open questions, each citing an ID and ending with `?`.
  5. A deny list, applied outside Constraints, Out of scope, and Open questions, rejects hosted databases, cloud services, containers, browser test tools, GraphQL and tRPC, live transport, and other sign-in methods.
  6. Each package in the Dependencies table exists on the npm registry (`npm view`), is not already in `package.json`, and names a decision.
- **Checked before the run.** Against a clone of the benchmark's `main` at `08fa0a7`, with its packages installed, a sample document passed all six commands. The first try showed the deny list flagging "no Docker" in Constraints, a fact the prompt asks for, so Constraints is exempt too. Eighteen mutations each failed only the command meant to catch them:
  - **Only change:** an extra file.
  - **Headings:** a renamed heading.
  - **IDs and coverage:** a decision ID gap, a decision citing no requirement, an unknown FR, a coverage table missing an ID, a range instead of IDs, and a coverage row with no decision.
  - **Content:** no SQLite in Decisions, no NFR-01 in Request flow, no deployment question, 7 open questions, and a question with no ID.
  - **Deny list:** PostgreSQL, and Playwright.
  - **Dependencies:** a package that doesn't exist, one already installed, and one with no decision.

  A `#` comment inside the code block still passed, as it should.

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
| T19 | Benchmark CI workflow through the factory | T16, Workflows permission (user) |
| T20 | Benchmark product brief from the product intent, through the factory | T16 |
| T21 | Benchmark requirements from the product brief, through the factory | T20 |
| T22 | Benchmark requirements revised with the operator's answers, through the factory | T21 |
| T23 | Benchmark architecture from the brief and requirements, through the factory | T22 |

## Out of scope

SQS, Kubernetes, dashboard, interactive Slack, multi-region, autoscaling, scheduler, and the task tracker. Resuming a blocked run is also out: the machine allows `blocked → provisioning`, but no command drives it yet.
