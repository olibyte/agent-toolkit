import { checkoutScript, publishScript } from "../github/scripts.ts";
import { RESULT_MARKER, shq } from "../shell.ts";
import type { Change, TaskSpec } from "../task.ts";
import type { Phase, WorkerEnvironment } from "./types.ts";

export const PHASE_TIMEOUT_SECONDS: Readonly<Record<Phase, number>> = {
  prepare: 900,
  change: 3600,
  verify: 1800,
  publish: 600,
};

const OUTPUT_TAIL_BYTES = 6000;
const WITHOUT_GITHUB_TOKEN = "unset GH_TOKEN GITHUB_TOKEN";

export interface PhaseContext {
  readonly runId: string;
  readonly task: TaskSpec;
  readonly branch: string;
  readonly environment: WorkerEnvironment;
}

export interface ChangeAttempt {
  readonly model: string | null;
  readonly feedback: string | null;
}

type AgentChange = Extract<Change, { kind: "agent" }>;

export function phasePaths(workdir: string) {
  return {
    cloneDir: `${workdir}/clone`,
    taskDir: `${workdir}/task`,
    repoDir: `${workdir}/task/repo`,
    signalFile: `${workdir}/task/signal.json`,
    patchFile: `${workdir}/changes.patch`,
    bodyFile: `${workdir}/pr-body.md`,
    logFile: (phase: Phase) => `${workdir}/logs/${phase}.log`,
    resultFile: (phase: Phase) => `${workdir}/${phase}.result.json`,
  };
}

export function agentPrompt(context: PhaseContext, change: AgentChange, feedback: string | null): string {
  const lines = [
    change.prompt,
    "",
    `You are running unattended as agent-factory run ${context.runId} in a fresh clone of ${context.task.repo} on branch ${context.branch}.`,
    "Edit files only. Do not commit, push, or open a pull request. The factory does that after verification.",
    `The factory will verify with: ${context.task.verify.join(" && ")}`,
    'If you cannot continue without a human decision, write {"status":"blocked","reason":"...","question":"..."} to the file named by $FACTORY_SIGNAL_FILE and stop.',
  ];
  if (feedback !== null) lines.push("", "A previous attempt failed verification with this output:", feedback);
  return lines.join("\n");
}

function asTask(context: PhaseContext, lines: readonly string[], env: readonly string[] = []): string {
  const { repoDir, signalFile } = phasePaths(context.environment.workdir);
  const script = [
    "set -euo pipefail",
    `export FACTORY_RUN_ID=${shq(context.runId)} FACTORY_BRANCH=${shq(context.branch)} FACTORY_SIGNAL_FILE=${shq(signalFile)}`,
    `cd ${shq(repoDir)}`,
    ...lines,
  ].join("\n");
  return ["factory_task", shq(script), ...env].join(" ");
}

function echoed(commands: readonly string[]): string[] {
  return commands.flatMap((command) => [`printf '$ %s\\n' ${shq(command)}`, `bash -c ${shq(command)}`]);
}

function agentChange(context: PhaseContext, change: AgentChange, attempt: ChangeAttempt): string[] {
  const prompt = agentPrompt(context, change, attempt.feedback);
  const model = attempt.model === null ? "" : ` --model ${shq(attempt.model)}`;
  const run = ['rm -f "$FACTORY_SIGNAL_FILE"'];
  switch (change.harness) {
    case "claude-code":
      return [
        'if key="$(factory_secret anthropic-api-key)" && [ -n "$key" ]; then export ANTHROPIC_API_KEY="$key"; fi',
        asTask(context, [...run, `IS_SANDBOX=1 claude -p ${shq(prompt)}${model} --dangerously-skip-permissions`], [
          "ANTHROPIC_API_KEY",
        ]),
      ];
    case "codex":
      return [
        `if key="$(factory_secret openai-api-key)" && [ -n "$key" ]; then printf '%s' "$key" | ${asTask(context, ["codex login --with-api-key"])}; fi`,
        asTask(context, [...run, `codex exec --dangerously-bypass-approvals-and-sandbox${model} ${shq(prompt)}`]),
      ];
  }
}

function changeBody(context: PhaseContext, attempt: ChangeAttempt): string[] {
  const change = context.task.change;
  const result = shq(phasePaths(context.environment.workdir).resultFile("change"));
  return [
    WITHOUT_GITHUB_TOKEN,
    ...(change.kind === "shell"
      ? [asTask(context, ['rm -f "$FACTORY_SIGNAL_FILE"', `bash -c ${shq(change.run)}`])]
      : agentChange(context, change, attempt)),
    `${asTask(context, ['if [ -s "$FACTORY_SIGNAL_FILE" ]; then cat "$FACTORY_SIGNAL_FILE"; fi'])} > ${result}`,
    `if [ -s ${result} ]; then exit 0; fi`,
    asTask(context, [
      'if [ -z "$(git status --porcelain)" ]; then echo "change produced no diff" >&2; exit 1; fi',
      "git status --short",
    ]),
  ];
}

function prepareBody(context: PhaseContext): string[] {
  const { environment, task, branch } = context;
  const paths = phasePaths(environment.workdir);
  return [
    environment.setup,
    ...(task.packages.length === 0 ? [] : [environment.installPackages(task.packages)]),
    environment.githubAuth,
    checkoutScript({ repo: task.repo, base: task.base, branch, repoDir: paths.cloneDir }),
    WITHOUT_GITHUB_TOKEN,
    `rm -rf ${shq(paths.taskDir)}`,
    `mkdir -p ${shq(paths.taskDir)}`,
    `cp -a ${shq(paths.cloneDir)} ${shq(paths.repoDir)}`,
    `factory_task_owns ${shq(paths.taskDir)}`,
    ...(task.change.kind === "agent" ? [environment.agentSetup(task.change.harness)] : []),
    ...(task.setup.length === 0 ? [] : [asTask(context, echoed(task.setup))]),
  ];
}

function publishBody(context: PhaseContext): string[] {
  const { environment, task, branch, runId } = context;
  const paths = phasePaths(environment.workdir);
  const patch = shq(paths.patchFile);
  return [
    WITHOUT_GITHUB_TOKEN,
    `export FACTORY_BASE_COMMIT="$(git -C ${shq(paths.cloneDir)} rev-parse HEAD)"`,
    `${asTask(context, ["git add --all", 'git diff --cached --binary "$FACTORY_BASE_COMMIT"'], ["FACTORY_BASE_COMMIT"])} > ${patch}`,
    `if [ -s ${patch} ]; then git -C ${shq(paths.cloneDir)} apply --index ${patch}; fi`,
    environment.githubAuth,
    publishScript({
      repo: task.repo,
      base: task.base,
      branch,
      repoDir: paths.cloneDir,
      title: task.title,
      commitTrailer: `Factory-Run: ${runId}`,
      body: `${task.body}\n\n---\nOpened by agent-factory run \`${runId}\`.`,
      bodyFile: paths.bodyFile,
      resultFile: paths.resultFile("publish"),
      autoMerge: task.autoMerge,
    }),
  ];
}

function body(phase: Phase, context: PhaseContext, attempt: ChangeAttempt): string[] {
  switch (phase) {
    case "prepare":
      return prepareBody(context);
    case "change":
      return changeBody(context, attempt);
    case "verify":
      return [WITHOUT_GITHUB_TOKEN, asTask(context, echoed(context.task.verify))];
    case "publish":
      return publishBody(context);
  }
}

export function renderPhase(
  phase: Phase,
  context: PhaseContext,
  attempt: ChangeAttempt = { model: null, feedback: null }
): string {
  const { workdir } = context.environment;
  const paths = phasePaths(workdir);
  const log = shq(paths.logFile(phase));
  const result = shq(paths.resultFile(phase));
  return [
    "#!/usr/bin/env bash",
    "set -uo pipefail",
    `mkdir -p ${shq(`${workdir}/logs`)}`,
    `rm -f ${result}`,
    "(",
    "set -euo pipefail",
    `echo "factory ${context.runId} phase ${phase} on \${HOSTNAME:-unknown} at $(date -u +%Y-%m-%dT%H:%M:%SZ)"`,
    context.environment.preamble,
    ...body(phase, context, attempt),
    `) > ${log} 2>&1 < /dev/null`,
    "status=$?",
    `tail -c ${OUTPUT_TAIL_BYTES} ${log}`,
    `if [ -s ${result} ]; then printf '\\n%s%s\\n' ${shq(RESULT_MARKER)} "$(tr -d '\\n' < ${result})"; fi`,
    'exit "$status"',
    "",
  ].join("\n");
}
