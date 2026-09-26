import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { cleanup, newRunId } from "./cli.ts";
import { runCommand } from "./exec.ts";
import { gitFixture } from "./fixtures.test-helper.ts";
import { openRunStore } from "./task-state/store.ts";
import { parseTask } from "./task.ts";

const CLI = join(import.meta.dirname, "cli.ts");

describe("factory cli", () => {
  it("runs a task on the local worker and records state, events, logs, and a summary", async () => {
    const fixture = await gitFixture();
    const stateDir = join(fixture.root, ".factory");
    const taskFile = join(fixture.root, "task.json");
    await writeFile(
      taskFile,
      JSON.stringify({
        repo: fixture.repo,
        title: "Add factory proof",
        change: { kind: "shell", run: "echo proof > PROOF.md" },
        verify: ["test -s PROOF.md"],
      })
    );
    const env = { ...fixture.env, FACTORY_SLACK_WEBHOOK_URL: "" };
    const run = await runCommand([process.execPath, CLI, "run", taskFile, "--worker", "local", "--state-dir", stateDir], {
      env,
      cwd: fixture.root,
    });
    assert.equal(run.code, 0, run.stderr);
    const record = JSON.parse(run.stdout);
    assert.equal(record.state, "completed");
    assert.match(run.stderr, /\[factory\] pr\.opened: PR <https:\/\/github.com\/owner\/sandbox\/pull\/1/);
    assert.match(run.stderr, /state pr_opened -> completed/);

    const state = JSON.parse(await readFile(join(stateDir, "runs", "state.json"), "utf8"));
    assert.equal(state.runs[0].id, record.id);
    assert.deepEqual((await readdir(stateDir)).sort(), ["runs"]);
    const summary = await readFile(join(stateDir, "runs", "last-run.md"), "utf8");
    assert.match(summary, new RegExp(`Run: \`${record.id}\` is \\*\\*completed\\*\\*`));
    assert.match(summary, /PR: \[#1\]\(https:\/\/github.com\/owner\/sandbox\/pull\/1\), open/);

    const runDir = join(stateDir, "runs", record.id);
    assert.deepEqual((await readdir(runDir)).sort(), [
      "change.log",
      "events.jsonl",
      "prepare.log",
      "publish.log",
      "verify.log",
    ]);
    const events = (await readFile(join(runDir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.filter((event) => event.type === "state.changed").length, 6);
    assert.deepEqual(
      events.filter((event) => event.type !== "state.changed").map((event) => event.type),
      ["factory.started", "worker.started", "pr.opened", "factory.completed"]
    );

    const status = await runCommand([process.execPath, CLI, "status", "--state-dir", stateDir], { env });
    assert.match(status.stdout, new RegExp(`^${record.id}  completed .*pull/1`));

    const cleanup = await runCommand([process.execPath, CLI, "cleanup", record.id, "--state-dir", stateDir], { env });
    assert.equal(cleanup.code, 0, cleanup.stderr);
    assert.equal(JSON.parse(cleanup.stdout).state, "completed");
  });

  it("rejects a missing worker choice with usage", async () => {
    const result = await runCommand([process.execPath, CLI, "run", "task.json"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /usage:/);
  });
});

describe("cleanup", () => {
  it("waits for an in-flight launch, then terminates the worker it recorded", async () => {
    const fixture = await gitFixture();
    const store = openRunStore(join(fixture.root, "state.json"));
    const task = parseTask({ repo: "owner/sandbox", title: "t", change: { kind: "shell", run: "true" }, verify: ["true"] });
    await store.create("run-1", task, "factory/run-1");
    await store.transition("run-1", "provisioning");
    const dir = join(fixture.root, "agent-factory-run-1-abc");
    await mkdir(dir);
    setTimeout(() => void store.update("run-1", { worker: { ref: { kind: "local", dir }, terminatedAt: null } }), 300);

    const run = await cleanup(store, "run-1", "interrupted by operator", { waitForLaunchMs: 5_000 });
    assert.equal(run.state, "failed");
    assert.notEqual(run.worker?.terminatedAt, null);
    assert.deepEqual(run.error, { phase: "cleanup", message: "interrupted by operator" });
    assert.equal(existsSync(dir), false);
  });
});

describe("run ids", () => {
  it("makes sortable run ids", () => {
    assert.match(newRunId(new Date("2026-09-25T16:45:01Z")), /^20260925-164501-[0-9a-f]{4}$/);
  });
});
