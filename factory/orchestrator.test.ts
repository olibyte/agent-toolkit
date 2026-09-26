import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { gitFixture } from "./fixtures.test-helper.ts";
import type { FactoryEvent } from "./notifications/events.ts";
import type { Notifier } from "./notifications/notifier.ts";
import { runTask, type OrchestratorDeps } from "./orchestrator.ts";
import { RESULT_MARKER } from "./shell.ts";
import { openRunStore } from "./task-state/store.ts";
import { parseTask, type TaskSpec } from "./task.ts";
import { localWorkerProvider } from "./worker/local.ts";
import type { Phase, PhaseResult, WorkerProvider } from "./worker/types.ts";

const prJson = (overrides: Record<string, unknown> = {}) => ({
  number: 12,
  url: "https://github.com/owner/sandbox/pull/12",
  title: "Add factory proof",
  state: "OPEN",
  headRefName: "factory/run-1",
  baseRefName: "main",
  isDraft: false,
  autoMergeRequest: null,
  ...overrides,
});
const ok = (output = "ok"): PhaseResult => ({ exitCode: 0, output });
const withResult = (data: unknown): PhaseResult => ok(`done\n${RESULT_MARKER}${JSON.stringify(data)}\n`);

interface FakeWorkerOptions {
  readonly results?: Partial<Record<Phase, PhaseResult[]>>;
  readonly launchFails?: boolean;
  readonly readyFails?: boolean;
  readonly terminateFails?: boolean;
}

function fakeWorker(options: FakeWorkerOptions = {}) {
  const calls: string[] = [];
  const scripts: Partial<Record<Phase, string[]>> = {};
  const results = { publish: [withResult(prJson())], ...options.results };
  const provider: WorkerProvider = {
    async launch() {
      calls.push("launch");
      if (options.launchFails) throw new Error("InsufficientInstanceCapacity");
      return { kind: "ec2", instanceId: "i-abc", region: "us-east-1", instanceType: "t3.small" };
    },
    async ready() {
      calls.push("ready");
      if (options.readyFails) throw new Error("timed out waiting for SSM registration of i-abc");
    },
    environment: () => ({ workdir: "/opt/agent-factory", preamble: "", githubAuth: "", setup: "", installPackages: () => "", agentSetup: () => "" }),
    async exec(_ref, phase, script) {
      calls.push(phase);
      (scripts[phase] ??= []).push(script);
      const queue = results[phase];
      return (queue && queue.length > 1 ? queue.shift() : queue?.[0]) ?? ok();
    },
    async terminate() {
      calls.push("terminate");
      if (options.terminateFails) throw new Error("UnauthorizedOperation");
    },
  };
  return { provider, calls, scripts };
}

function shellTask(overrides: Record<string, unknown> = {}): TaskSpec {
  return parseTask({
    repo: "owner/sandbox",
    title: "Add factory proof",
    change: { kind: "shell", run: "date -u > PROOF.md" },
    verify: ["test -s PROOF.md"],
    ...overrides,
  });
}

async function harness(worker: WorkerProvider) {
  const dir = await mkdtemp(join(tmpdir(), "factory-orchestrator-"));
  const events: FactoryEvent[] = [];
  const logs: string[] = [];
  const notifier: Notifier = { notify: async (event) => void events.push(event) };
  const deps: OrchestratorDeps = {
    store: openRunStore(join(dir, "state.json")),
    worker,
    notifier,
    saveLog: async (_runId, name) => void logs.push(name),
  };
  return { deps, events, logs, dir };
}

const states = (run: { history: readonly { to: string }[] }) => run.history.map((entry) => entry.to);
const types = (events: readonly FactoryEvent[]) => events.map((event) => event.type);

describe("orchestrator", () => {
  it("drives a run from queued to completed and cleans up the worker", async () => {
    const worker = fakeWorker();
    const { deps, events, logs } = await harness(worker.provider);
    const run = await runTask(deps, shellTask(), "run-1");

    assert.deepEqual(states(run), ["queued", "provisioning", "running", "verifying", "pr_opened", "completed"]);
    assert.deepEqual(worker.calls, ["launch", "ready", "prepare", "change", "verify", "publish", "terminate"]);
    assert.deepEqual(types(events), ["factory.started", "worker.started", "pr.opened", "factory.completed"]);
    assert.deepEqual(logs, ["prepare", "change", "verify", "publish"]);
    assert.equal(run.pr?.number, 12);
    assert.equal(run.branch, "factory/run-1");
    assert.notEqual(run.worker?.terminatedAt, null);
    assert.equal(run.error, null);
    const completed = events.at(-1);
    assert.equal(completed?.type === "factory.completed" && completed.outcome, "completed");
  });

  it("fails on verification, skips publishing, and still terminates", async () => {
    const worker = fakeWorker({ results: { verify: [{ exitCode: 1, output: "$ test -s PROOF.md\n" }] } });
    const { deps, events } = await harness(worker.provider);
    const run = await runTask(deps, shellTask(), "run-1");

    assert.equal(run.state, "failed");
    assert.deepEqual(run.error, { phase: "verify", message: "verify exited 1: $ test -s PROOF.md" });
    assert.equal(worker.calls.includes("publish"), false);
    assert.equal(worker.calls.at(-1), "terminate");
    assert.deepEqual(types(events), ["factory.started", "worker.started", "worker.failed", "factory.completed"]);
  });

  it("records a launch failure without trying to terminate", async () => {
    const worker = fakeWorker({ launchFails: true });
    const { deps } = await harness(worker.provider);
    const run = await runTask(deps, shellTask(), "run-1");
    assert.deepEqual(states(run), ["queued", "provisioning", "failed"]);
    assert.deepEqual(run.error, { phase: "provision", message: "InsufficientInstanceCapacity" });
    assert.deepEqual(worker.calls, ["launch"]);
    assert.equal(run.worker, null);
  });

  it("terminates a worker that never became ready", async () => {
    const worker = fakeWorker({ readyFails: true });
    const { deps } = await harness(worker.provider);
    const run = await runTask(deps, shellTask(), "run-1");
    assert.equal(run.state, "failed");
    assert.equal(run.error?.phase, "provision");
    assert.deepEqual(worker.calls, ["launch", "ready", "terminate"]);
    assert.equal(run.worker?.ref.kind, "ec2");
  });

  it("parks a blocked agent, asks its question, and releases the worker", async () => {
    const signal = { status: "blocked", reason: "needs a product call", question: "Keep the old API?" };
    const worker = fakeWorker({ results: { change: [withResult(signal)] } });
    const { deps, events } = await harness(worker.provider);
    const run = await runTask(deps, shellTask(), "run-1");

    assert.deepEqual(states(run), ["queued", "provisioning", "running", "blocked"]);
    assert.deepEqual(run.blocked, { reason: "needs a product call", question: "Keep the old API?" });
    assert.deepEqual(worker.calls, ["launch", "ready", "prepare", "change", "terminate"]);
    assert.deepEqual(types(events), [
      "factory.started",
      "worker.started",
      "agent.blocked",
      "agent.question",
      "factory.completed",
    ]);
  });

  it("escalates an agent change once after a verification failure", async () => {
    const task = shellTask({
      change: { kind: "agent", harness: "claude-code", prompt: "Add PROOF.md", escalationModel: "opus" },
    });
    const worker = fakeWorker({
      results: { verify: [{ exitCode: 1, output: "PROOF.md is empty\n" }, ok()] },
    });
    const { deps, logs } = await harness(worker.provider);
    const run = await runTask(deps, task, "run-1");

    assert.equal(run.state, "completed");
    assert.deepEqual(states(run), [
      "queued",
      "provisioning",
      "running",
      "verifying",
      "running",
      "verifying",
      "pr_opened",
      "completed",
    ]);
    assert.match(run.history[4]?.reason ?? "", /verify exited 1: PROOF.md is empty; retrying with opus/);
    assert.match(worker.scripts.change?.[0] ?? "", /--model \S*sonnet/);
    assert.match(worker.scripts.change?.[1] ?? "", /--model \S*opus/);
    assert.match(worker.scripts.change?.[1] ?? "", /failed verification with this output:\nPROOF.md is empty/);
    assert.deepEqual(logs, ["prepare", "change-1", "verify-1", "change-2", "verify-2", "publish"]);
  });

  it("does not retry without an escalation model", async () => {
    const task = shellTask({ change: { kind: "agent", harness: "claude-code", prompt: "Add PROOF.md" } });
    const worker = fakeWorker({ results: { verify: [{ exitCode: 1, output: "nope\n" }] } });
    const { deps } = await harness(worker.provider);
    const run = await runTask(deps, task, "run-1");
    assert.equal(run.state, "failed");
    assert.equal(worker.calls.filter((call) => call === "change").length, 1);
  });

  it("fails a run whose worker could not be terminated", async () => {
    const worker = fakeWorker({ terminateFails: true });
    const { deps, events } = await harness(worker.provider);
    const run = await runTask(deps, shellTask(), "run-1");
    assert.deepEqual(states(run), ["queued", "provisioning", "running", "verifying", "pr_opened", "failed"]);
    assert.equal(run.error?.phase, "terminate");
    assert.match(run.error?.message ?? "", /factory cleanup run-1/);
    assert.equal(run.worker?.terminatedAt, null);
    assert.ok(types(events).includes("worker.failed"));
  });

  it("announces a merge when the PR merged during publish", async () => {
    const worker = fakeWorker({ results: { publish: [withResult(prJson({ state: "MERGED" }))] } });
    const { deps, events } = await harness(worker.provider);
    await runTask(deps, shellTask({ autoMerge: true }), "run-1");
    assert.deepEqual(types(events).slice(2), ["pr.opened", "pr.merged", "factory.completed"]);
  });

  it("rejects a malformed agent signal", async () => {
    const worker = fakeWorker({ results: { change: [withResult({ status: "stuck" })] } });
    const { deps } = await harness(worker.provider);
    const run = await runTask(deps, shellTask(), "run-1");
    assert.equal(run.state, "failed");
    assert.match(run.error?.message ?? "", /agent signal must be/);
  });
});

describe("orchestrator with the local worker", () => {
  it("opens a PR from a real clone and removes the workspace", async () => {
    const fixture = await gitFixture();
    const worker = localWorkerProvider({ root: fixture.root, env: fixture.env });
    const { deps } = await harness(worker);
    const run = await runTask(deps, shellTask({ verify: ["test -s PROOF.md", "git diff --quiet HEAD -- README.md"] }), "run-1");

    assert.equal(run.state, "completed", JSON.stringify(run.error));
    assert.equal(run.pr?.url, "https://github.com/owner/sandbox/pull/1");
    assert.equal(run.pr?.headRefName, "factory/run-1");
    const gh = await fixture.gh();
    assert.match(gh.prs[0]?.body ?? "", /Opened by agent-factory run `run-1`/);
    assert.equal(existsSync(run.worker?.ref.kind === "local" ? run.worker.ref.dir : "/"), false);
  });
});
