import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseTask } from "./task.ts";

const minimal = {
  repo: "owner/app",
  title: "Scaffold",
  change: { kind: "shell", run: "true" },
  verify: ["npm test"],
};

describe("task spec", () => {
  it("defaults packages and setup to nothing", () => {
    const task = parseTask(minimal);
    assert.deepEqual(task.packages, []);
    assert.deepEqual(task.setup, []);
  });

  it("accepts package names and setup commands", () => {
    const task = parseTask({ ...minimal, packages: ["python3.12", "gcc-c++", "nodejs22"], setup: ["npm ci"] });
    assert.deepEqual(task.packages, ["python3.12", "gcc-c++", "nodejs22"]);
    assert.deepEqual(task.setup, ["npm ci"]);
  });

  it("rejects package names that could carry shell or dnf options", () => {
    for (const name of ["-y", "git; curl x", "a b", "$(id)", ""]) {
      assert.throws(() => parseTask({ ...minimal, packages: [name] }), /packages must be a list of package names/);
    }
    assert.throws(() => parseTask({ ...minimal, setup: "npm ci" }), /setup must be a list of shell commands/);
    assert.throws(() => parseTask({ ...minimal, setup: [""] }), /setup must be a list/);
    assert.throws(() => parseTask({ ...minimal, verify: [] }), /verify must be a non-empty list/);
  });
});
