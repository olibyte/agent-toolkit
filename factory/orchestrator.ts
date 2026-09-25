import { taskBranch } from "./github/scripts.ts";
import { parsePullRequest } from "./github/pr.ts";
import type { FactoryEvent } from "./notifications/events.ts";
import type { Notifier } from "./notifications/notifier.ts";
import { parseResultLine } from "./shell.ts";
import { isTerminal } from "./task-state/machine.ts";
import type { RunRecord, RunStore } from "./task-state/store.ts";
import type { TaskSpec } from "./task.ts";
import { PHASE_TIMEOUT_SECONDS, renderPhase, type ChangeAttempt, type PhaseContext } from "./worker/phases.ts";
import type { Phase, WorkerProvider, WorkerRef } from "./worker/types.ts";

export interface OrchestratorDeps {
  readonly store: RunStore;
  readonly worker: WorkerProvider;
  readonly notifier: Notifier;
  readonly saveLog: (runId: string, name: string, output: string) => Promise<void>;
  readonly now?: () => Date;
}

type EventInput = FactoryEvent extends infer E ? (E extends FactoryEvent ? Omit<E, "runId" | "at" | "repo"> : never) : never;
type Step = "provision" | Phase | "terminate";

export class StepFailure extends Error {
  override name = "StepFailure";
  readonly step: Step;

  constructor(step: Step, message: string) {
    super(message);
    this.step = step;
  }
}

function lastLine(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("::factory-result::"));
  return (lines.at(-1) ?? "no output").slice(0, 300);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseSignal(data: unknown): { reason: string; question: string | null } | null {
  if (data === undefined) return null;
  const signal = data as { status?: unknown; reason?: unknown; question?: unknown } | null;
  if (signal?.status !== "blocked" || typeof signal.reason !== "string") {
    throw new StepFailure("change", 'agent signal must be {"status":"blocked","reason":"..."}');
  }
  return { reason: signal.reason, question: typeof signal.question === "string" ? signal.question : null };
}

function changeAttempts(task: TaskSpec): readonly ChangeAttempt[] {
  const change = task.change;
  if (change.kind !== "agent") return [{ model: null, feedback: null }];
  const first = { model: change.model, feedback: null };
  return change.escalationModel === null ? [first] : [first, { model: change.escalationModel, feedback: null }];
}

export async function runTask(deps: OrchestratorDeps, task: TaskSpec, runId: string): Promise<RunRecord> {
  const { store, worker, notifier } = deps;
  const now = deps.now ?? (() => new Date());
  const branch = taskBranch(task.branchPrefix, runId);
  const emit = (event: EventInput) =>
    notifier.notify({ ...event, runId, at: now().toISOString(), repo: task.repo } as FactoryEvent);

  await store.create(runId, task, branch);
  await emit({ type: "factory.started", title: task.title, branch });

  let ref: WorkerRef | null = null;
  let step: Step = "provision";

  async function exec(context: PhaseContext, phase: Phase, logName: string, attempt?: ChangeAttempt) {
    if (ref === null) throw new StepFailure(phase, "no worker");
    step = phase;
    const result = await worker.exec(ref, phase, renderPhase(phase, context, attempt), PHASE_TIMEOUT_SECONDS[phase]);
    await deps.saveLog(runId, logName, result.output);
    let data: unknown;
    try {
      data = parseResultLine(result.output);
    } catch {
      throw new StepFailure(phase, `${phase} printed an unreadable result line`);
    }
    return { ...result, data };
  }

  async function required(context: PhaseContext, phase: Phase, logName: string = phase, attempt?: ChangeAttempt) {
    const result = await exec(context, phase, logName, attempt);
    if (result.exitCode !== 0) {
      throw new StepFailure(phase, `${phase} exited ${result.exitCode}: ${lastLine(result.output)}`);
    }
    return result.data;
  }

  try {
    await store.transition(runId, "provisioning");
    ref = await worker.launch(runId);
    await store.update(runId, { worker: { ref, terminatedAt: null } });
    await worker.ready(ref);
    await emit({ type: "worker.started", worker: ref });
    const context: PhaseContext = { runId, task, branch, environment: worker.environment(ref) };

    await required(context, "prepare");
    await store.transition(runId, "running");

    const attempts = changeAttempts(task);
    let feedback: string | null = null;
    for (const [index, planned] of attempts.entries()) {
      const attempt = { ...planned, feedback };
      const suffix = attempts.length > 1 ? `-${index + 1}` : "";
      const signal = parseSignal(await required(context, "change", `change${suffix}`, attempt));
      if (signal !== null) {
        await store.update(runId, { blocked: signal });
        await store.transition(runId, "blocked", signal.reason);
        await emit({ type: "agent.blocked", reason: signal.reason });
        if (signal.question !== null) await emit({ type: "agent.question", question: signal.question });
        break;
      }
      await store.transition(runId, "verifying");
      const verified = await exec(context, "verify", `verify${suffix}`);
      if (verified.exitCode === 0) {
        const pr = parsePullRequest(await required(context, "publish"));
        await store.update(runId, { pr });
        await store.transition(runId, "pr_opened", pr.url);
        await emit({ type: "pr.opened", pr });
        if (pr.state === "MERGED") await emit({ type: "pr.merged", pr });
        break;
      }
      const failure = `verify exited ${verified.exitCode}: ${lastLine(verified.output)}`;
      const next = attempts[index + 1];
      if (next === undefined) throw new StepFailure("verify", failure);
      feedback = verified.output.slice(-4000);
      await store.transition(runId, "running", `${failure}; retrying with ${next.model ?? "default model"}`);
    }
  } catch (error) {
    const failed = error instanceof StepFailure ? error.step : step;
    const message = errorMessage(error);
    await store.update(runId, { error: { phase: failed, message } });
    const current = await store.get(runId);
    if (current !== null && !isTerminal(current.state)) await store.transition(runId, "failed", message);
    await emit({ type: "worker.failed", phase: failed, error: message });
  }

  if (ref !== null) {
    try {
      await worker.terminate(ref);
      await store.update(runId, { worker: { ref, terminatedAt: now().toISOString() } });
    } catch (error) {
      const message = `worker termination failed: ${errorMessage(error)}. Run: factory cleanup ${runId}`;
      const current = await store.get(runId);
      if (current?.error === null) await store.update(runId, { error: { phase: "terminate", message } });
      if (current !== null && !isTerminal(current.state)) await store.transition(runId, "failed", message);
      await emit({ type: "worker.failed", phase: "terminate", error: message });
    }
  }

  let run = await store.get(runId);
  if (run === null) throw new Error(`run ${runId} disappeared from the state file`);
  if (run.state === "pr_opened") run = await store.transition(runId, "completed");
  const outcome = run.state === "completed" ? "completed" : run.state === "blocked" ? "blocked" : "failed";
  await emit({ type: "factory.completed", outcome, pr: run.pr, error: run.error?.message ?? null });
  return run;
}
