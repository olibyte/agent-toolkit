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
    repoDir: `${workdir}/repo`,
    signalFile: `${workdir}/signal.json`,
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

function agentCommand(change: AgentChange, prompt: string, model: string | null): string {
  switch (change.harness) {
    case "claude-code":
      return [
        'if key="$(factory_secret anthropic-api-key)" && [ -n "$key" ]; then export ANTHROPIC_API_KEY="$key"; fi',
        `IS_SANDBOX=1 claude -p ${shq(prompt)}${model === null ? "" : ` --model ${shq(model)}`} --dangerously-skip-permissions`,
      ].join("\n");
    case "codex":
      return [
        'if key="$(factory_secret openai-api-key)" && [ -n "$key" ]; then printf \'%s\' "$key" | codex login --with-api-key; fi',
        `codex exec --dangerously-bypass-approvals-and-sandbox${model === null ? "" : ` --model ${shq(model)}`} ${shq(prompt)}`,
      ].join("\n");
  }
}

function changeBody(context: PhaseContext, attempt: ChangeAttempt): string {
  const paths = phasePaths(context.environment.workdir);
  const change = context.task.change;
  const run =
    change.kind === "shell"
      ? `bash -c ${shq(change.run)}`
      : [
          context.environment.agentSetup(change.harness),
          agentCommand(change, agentPrompt(context, change, attempt.feedback), attempt.model),
        ].join("\n");
  return [
    WITHOUT_GITHUB_TOKEN,
    `export FACTORY_SIGNAL_FILE=${shq(paths.signalFile)}`,
    'rm -f "$FACTORY_SIGNAL_FILE"',
    `cd ${shq(paths.repoDir)}`,
    run,
    `if [ -s "$FACTORY_SIGNAL_FILE" ]; then cp "$FACTORY_SIGNAL_FILE" ${shq(paths.resultFile("change"))}; exit 0; fi`,
    'if [ -z "$(git status --porcelain)" ]; then echo "change produced no diff" >&2; exit 1; fi',
    "git status --short",
  ].join("\n");
}

function verifyBody(context: PhaseContext): string {
  const { repoDir } = phasePaths(context.environment.workdir);
  return [
    WITHOUT_GITHUB_TOKEN,
    `cd ${shq(repoDir)}`,
    ...context.task.verify.flatMap((command) => [`printf '$ %s\\n' ${shq(command)}`, `bash -c ${shq(command)}`]),
  ].join("\n");
}

function body(phase: Phase, context: PhaseContext, attempt: ChangeAttempt): string {
  const paths = phasePaths(context.environment.workdir);
  const { task, branch, runId } = context;
  switch (phase) {
    case "prepare":
      return [
        context.environment.setup,
        context.environment.githubAuth,
        checkoutScript({ repo: task.repo, base: task.base, branch, repoDir: paths.repoDir }),
      ].join("\n");
    case "change":
      return changeBody(context, attempt);
    case "verify":
      return verifyBody(context);
    case "publish":
      return [
        context.environment.githubAuth,
        publishScript({
          repo: task.repo,
          base: task.base,
          branch,
          repoDir: paths.repoDir,
          title: task.title,
          commitTrailer: `Factory-Run: ${runId}`,
          body: `${task.body}\n\n---\nOpened by agent-factory run \`${runId}\`.`,
          bodyFile: paths.bodyFile,
          resultFile: paths.resultFile("publish"),
          autoMerge: task.autoMerge,
        }),
      ].join("\n");
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
    `export FACTORY_RUN_ID=${shq(context.runId)} FACTORY_BRANCH=${shq(context.branch)}`,
    context.environment.preamble,
    body(phase, context, attempt),
    `) > ${log} 2>&1 < /dev/null`,
    "status=$?",
    `tail -c ${OUTPUT_TAIL_BYTES} ${log}`,
    `if [ -s ${result} ]; then printf '\\n%s%s\\n' ${shq(RESULT_MARKER)} "$(tr -d '\\n' < ${result})"; fi`,
    'exit "$status"',
    "",
  ].join("\n");
}
