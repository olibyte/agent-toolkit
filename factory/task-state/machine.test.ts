import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  InvalidTransitionError,
  RUN_STATES,
  assertTransition,
  canTransition,
  isTerminal,
} from "./machine.ts";

describe("run state machine", () => {
  it("walks the happy path", () => {
    const path = ["queued", "provisioning", "running", "verifying", "pr_opened", "completed"] as const;
    for (let index = 1; index < path.length; index += 1) {
      assert.ok(canTransition(path[index - 1]!, path[index]!), `${path[index - 1]} -> ${path[index]}`);
    }
  });

  it("lets every non-terminal state fail", () => {
    for (const state of RUN_STATES) {
      if (!isTerminal(state)) assert.ok(canTransition(state, "failed"), state);
    }
  });

  it("treats only completed and failed as terminal", () => {
    assert.deepEqual(RUN_STATES.filter(isTerminal), ["completed", "failed"]);
  });

  it("allows blocking, resuming, and one retry from verification", () => {
    assert.ok(canTransition("running", "blocked"));
    assert.ok(canTransition("blocked", "running"));
    assert.ok(canTransition("blocked", "provisioning"));
    assert.ok(canTransition("verifying", "running"));
  });

  it("rejects skipping verification or leaving a terminal state", () => {
    assert.throws(() => assertTransition("running", "pr_opened"), InvalidTransitionError);
    assert.throws(() => assertTransition("queued", "running"), InvalidTransitionError);
    assert.throws(() => assertTransition("completed", "failed"), /completed -> failed/);
    assert.throws(() => assertTransition("failed", "queued"), InvalidTransitionError);
  });
});
