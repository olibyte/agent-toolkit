import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { TaskSpec } from "../task.ts";
import { InvalidTransitionError } from "./machine.ts";
import { openRunStore, type StateChange } from "./store.ts";

const task: TaskSpec = {
  repo: "owner/sandbox",
  base: "main",
  title: "Trivial change",
  body: "Trivial change",
  change: { kind: "shell", run: "date > PROOF.md" },
  verify: ["test -s PROOF.md"],
  autoMerge: false,
  branchPrefix: "factory/",
};

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "factory-store-"));
}

function clock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 8, 25, 12, 0, tick++));
}

describe("run store", () => {
  it("persists transitions with history and emits state-change events", async () => {
    const dir = await scratch();
    const path = join(dir, "state.json");
    const changes: StateChange[] = [];
    const store = openRunStore(path, { now: clock(), onChange: (change) => changes.push(change) });

    await store.create("run-1", task, "factory/run-1");
    await store.transition("run-1", "provisioning");
    await store.update("run-1", { worker: { ref: { kind: "local", dir: "/tmp/w" }, terminatedAt: null } });
    await store.transition("run-1", "failed", "clone failed");

    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.equal(saved.version, 1);
    assert.equal(saved.runs[0].state, "failed");
    assert.deepEqual(saved.runs[0].worker.ref, { kind: "local", dir: "/tmp/w" });
    assert.deepEqual(
      saved.runs[0].history.map((entry: { from: string | null; to: string }) => [entry.from, entry.to]),
      [
        [null, "queued"],
        ["queued", "provisioning"],
        ["provisioning", "failed"],
      ]
    );
    assert.deepEqual(
      changes.map((change) => [change.runId, change.to, change.reason]),
      [
        ["run-1", "queued", null],
        ["run-1", "provisioning", null],
        ["run-1", "failed", "clone failed"],
      ]
    );
    assert.equal(saved.runs[0].updatedAt, "2026-09-25T12:00:03.000Z");
  });

  it("rejects an invalid transition without writing it", async () => {
    const path = join(await scratch(), "state.json");
    const store = openRunStore(path);
    await store.create("run-1", task, "factory/run-1");
    await assert.rejects(store.transition("run-1", "pr_opened"), InvalidTransitionError);
    assert.equal((await store.get("run-1"))?.state, "queued");
    assert.equal((await store.get("run-1"))?.history.length, 1);
  });

  it("keeps other top-level keys and leaves no temporary files", async () => {
    const dir = await scratch();
    const path = join(dir, "state.json");
    await writeFile(path, JSON.stringify({ version: 1, work: { goal: "keep me" }, runs: [] }));
    const store = openRunStore(path);
    await store.create("run-1", task, "factory/run-1");
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(saved.work, { goal: "keep me" });
    assert.deepEqual(await readdir(dir), ["state.json"]);
  });

  it("serializes concurrent writers in one process", async () => {
    const path = join(await scratch(), "state.json");
    const store = openRunStore(path);
    await Promise.all(["a", "b", "c", "d"].map((id) => store.create(id, task, `factory/${id}`)));
    assert.deepEqual((await store.list()).map((run) => run.id).sort(), ["a", "b", "c", "d"]);
  });

  it("refuses unknown runs and unknown file versions", async () => {
    const dir = await scratch();
    const path = join(dir, "state.json");
    await assert.rejects(openRunStore(path).transition("missing", "failed"), /no run missing/);
    await writeFile(path, JSON.stringify({ version: 2, runs: [] }));
    await assert.rejects(openRunStore(path).list(), /version 1/);
  });
});
