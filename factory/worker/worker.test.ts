import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runCommand } from "../exec.ts";
import { gitFixture, type GitFixture } from "../fixtures.test-helper.ts";
import { parseResultLine } from "../shell.ts";
import { parseTask, type TaskSpec } from "../task.ts";
import { localWorkerProvider } from "./local.ts";
import { PHASES, type Phase, type WorkerEnvironment } from "./types.ts";
import { PHASE_TIMEOUT_SECONDS, agentPrompt, renderPhase, type ChangeAttempt, type PhaseContext } from "./phases.ts";

function shellTask(overrides: Record<string, unknown> = {}): TaskSpec {
  return parseTask({
    repo: "owner/sandbox",
    title: "Add factory proof",
    change: { kind: "shell", run: "echo \"it's $((1 + 1)) on $FACTORY_BRANCH\" > PROOF.md" },
    verify: ["test -s PROOF.md", "grep -q \"it's 2 on factory/$FACTORY_RUN_ID\" PROOF.md"],
    ...overrides,
  });
}

async function localRun(fixture: GitFixture, task: TaskSpec) {
  const provider = localWorkerProvider({ root: fixture.root, env: fixture.env });
  const ref = await provider.launch("run-1");
  const context: PhaseContext = { runId: "run-1", task, branch: "factory/run-1", environment: provider.environment(ref) };
  const exec = async (phase: Phase, attempt?: ChangeAttempt) => {
    const result = await provider.exec(ref, phase, renderPhase(phase, context, attempt), PHASE_TIMEOUT_SECONDS[phase]);
    return { ...result, data: parseResultLine(result.output) };
  };
  return { provider, ref, context, exec };
}

describe("phase scripts", () => {
  it("render as valid bash for shell and agent tasks", async () => {
    const environment: WorkerEnvironment = {
      workdir: "/opt/agent-factory/run 1",
      preamble: "factory_secret() { return 1; }",
      githubAuth: "export GH_TOKEN=from-auth",
      setup: "true",
      installPackages: () => "true",
      agentSetup: () => "true",
    };
    const tasks = [
      shellTask({ body: "it's $(dangerous) `too`", packages: ["python3.12"], setup: ["npm ci --ignore-scripts=false"] }),
      shellTask({
        change: { kind: "agent", harness: "claude-code", prompt: "Fix the 'bug' in $HOME" },
        autoMerge: true,
      }),
      shellTask({ change: { kind: "agent", harness: "codex", prompt: "Refactor", model: "gpt-x" } }),
    ];
    for (const task of tasks) {
      for (const phase of PHASES) {
        const script = renderPhase(phase, { runId: "run-1", task, branch: "factory/run-1", environment }, {
          model: "opus",
          feedback: "verify said: it's broken",
        });
        const syntax = await runCommand(["bash", "-n"], { input: script });
        assert.equal(syntax.code, 0, `${task.change.kind} ${phase}: ${syntax.stderr}`);
      }
    }
  });

  it("tells the agent how to verify, how to signal a block, and what failed before", () => {
    const task = shellTask({ change: { kind: "agent", harness: "claude-code", prompt: "Add a proof file" } });
    const change = task.change;
    assert.equal(change.kind, "agent");
    if (change.kind !== "agent") return;
    assert.equal(change.model, "sonnet");
    const prompt = agentPrompt(
      { runId: "run-1", task, branch: "factory/run-1", environment: {} as WorkerEnvironment },
      change,
      "exit 1"
    );
    assert.match(prompt, /^Add a proof file\n/);
    assert.match(prompt, /test -s PROOF.md && grep/);
    assert.match(prompt, /\$FACTORY_SIGNAL_FILE/);
    assert.match(prompt, /failed verification with this output:\nexit 1$/);
  });
});

describe("local worker", () => {
  it("runs prepare, change, verify, and publish against a real git origin", async () => {
    const fixture = await gitFixture();
    const { exec, provider, ref } = await localRun(fixture, shellTask());

    for (const phase of ["prepare", "change", "verify"] as const) {
      const result = await exec(phase);
      assert.equal(result.exitCode, 0, `${phase}:\n${result.output}`);
    }
    const published = await exec("publish");
    assert.equal(published.exitCode, 0, published.output);
    assert.equal((published.data as { url: string }).url, "https://github.com/owner/sandbox/pull/1");
    assert.equal(await fixture.git("--git-dir", fixture.origin, "show", "factory/run-1:PROOF.md"), "it's 2 on factory/run-1");

    await provider.terminate(ref);
    assert.equal(existsSync(ref.kind === "local" ? ref.dir : ""), false);
  });

  it("fails verification with the failing command's output", async () => {
    const fixture = await gitFixture();
    const { exec } = await localRun(fixture, shellTask({ verify: ["test -s PROOF.md", "echo 'lint: 3 errors' >&2; exit 3"] }));
    await exec("prepare");
    await exec("change");
    const result = await exec("verify");
    assert.equal(result.exitCode, 3);
    assert.match(result.output, /\$ test -s PROOF.md\n\$ echo 'lint: 3 errors' >&2; exit 3\nlint: 3 errors/);
  });

  it("keeps the GitHub token away from task commands", async () => {
    const fixture = await gitFixture();
    const { exec } = await localRun(
      fixture,
      shellTask({
        change: { kind: "shell", run: 'echo "token=${GH_TOKEN:-none}" > PROOF.md' },
        verify: ['test -z "${GH_TOKEN:-}${GITHUB_TOKEN:-}"', "grep -qx token=none PROOF.md"],
      })
    );
    assert.equal(fixture.env["GH_TOKEN"], "fake-token");
    for (const phase of ["prepare", "change", "verify", "publish"] as const) {
      const result = await exec(phase);
      assert.equal(result.exitCode, 0, `${phase}:\n${result.output}`);
    }
  });

  it("runs setup commands in the repo before the change, without the GitHub token", async () => {
    const fixture = await gitFixture();
    const { exec } = await localRun(
      fixture,
      shellTask({
        packages: ["gcc"],
        setup: ["mkdir -p .tools && echo \"node for $FACTORY_RUN_ID\" > .tools/runtime", 'test -z "${GH_TOKEN:-}"'],
        change: { kind: "shell", run: "cp .tools/runtime PROOF.md && rm -r .tools" },
        verify: ["grep -qx 'node for run-1' PROOF.md"],
      })
    );
    const prepared = await exec("prepare");
    assert.equal(prepared.exitCode, 0, prepared.output);
    assert.match(prepared.output, /local worker skips packages.*: gcc/);
    assert.match(prepared.output, /\$ mkdir -p \.tools/);
    for (const phase of ["change", "verify", "publish"] as const) {
      const result = await exec(phase);
      assert.equal(result.exitCode, 0, `${phase}:\n${result.output}`);
    }
    assert.equal(await fixture.git("--git-dir", fixture.origin, "show", "factory/run-1:PROOF.md"), "node for run-1");
  });

  it("publishes from its own clone, so hooks planted in the task repo never run", async () => {
    const fixture = await gitFixture();
    const marker = join(fixture.root, "hook-ran");
    const { exec } = await localRun(
      fixture,
      shellTask({
        change: {
          kind: "shell",
          run: [
            "echo committed > COMMITTED.md && git add COMMITTED.md && git -c user.name=t -c user.email=t@example.com commit -qm agent",
            `printf '#!/bin/sh\\ntouch ${marker}\\n' > .git/hooks/pre-commit`,
            "cp .git/hooks/pre-commit .git/hooks/pre-push && chmod +x .git/hooks/pre-commit .git/hooks/pre-push",
            "printf 'bin\\0' > tool.bin && chmod +x tool.bin",
            "echo staged > PROOF.md",
          ].join(" && "),
        },
        verify: ["test -f COMMITTED.md"],
      })
    );
    for (const phase of PHASES) {
      const result = await exec(phase);
      assert.equal(result.exitCode, 0, `${phase}:\n${result.output}`);
    }
    assert.equal(existsSync(marker), false, "a hook from the task repo ran during publish");
    const tree = await fixture.git("--git-dir", fixture.origin, "ls-tree", "-r", "factory/run-1");
    assert.match(tree, /^100644 blob \S+\tCOMMITTED\.md$/m);
    assert.match(tree, /^100644 blob \S+\tPROOF\.md$/m);
    assert.match(tree, /^100755 blob \S+\ttool\.bin$/m);
    assert.equal(await fixture.git("--git-dir", fixture.origin, "rev-list", "--count", "main..factory/run-1"), "1");
  });

  it("refuses a forged patch that writes into the publish clone's .git", async () => {
    const fixture = await gitFixture();
    const forged = [
      "diff --git a/.git/hooks/pre-commit b/.git/hooks/pre-commit",
      "new file mode 100755",
      "--- /dev/null",
      "+++ b/.git/hooks/pre-commit",
      "@@ -0,0 +1 @@",
      `+touch ${join(fixture.root, "hook-ran")}`,
    ].join("\\n");
    const { exec } = await localRun(
      fixture,
      shellTask({
        change: {
          kind: "shell",
          run: `printf '#!/bin/sh\\nprintf "${forged}\\\\n"\\n' > .git/forge && chmod +x .git/forge && git config diff.external "$PWD/.git/forge" && echo x > PROOF.md`,
        },
        verify: ["true"],
      })
    );
    for (const phase of ["prepare", "change", "verify"] as const) {
      const result = await exec(phase);
      assert.equal(result.exitCode, 0, `${phase}:\n${result.output}`);
    }
    const published = await exec("publish");
    assert.notEqual(published.exitCode, 0, published.output);
    assert.match(published.output, /invalid path '\.git\/hooks\/pre-commit'/);
    assert.equal((await fixture.gh()).prs.length, 0);
  });

  it("fails a change that produces no diff", async () => {
    const fixture = await gitFixture();
    const { exec } = await localRun(fixture, shellTask({ change: { kind: "shell", run: "true" } }));
    await exec("prepare");
    const result = await exec("change");
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /change produced no diff/);
  });

  it("runs an agent change and reports a blocked agent through the signal file", async () => {
    const fixture = await gitFixture();
    const task = shellTask({
      change: { kind: "agent", harness: "claude-code", prompt: "Write AGENT.md" },
      verify: ["test -s AGENT.md"],
    });
    const working = await localRun(fixture, task);
    await working.exec("prepare");
    const changed = await working.exec("change", { model: "opus", feedback: null });
    assert.equal(changed.exitCode, 0, changed.output);
    const args = await readFile(join(fixture.env["FAKE_GH_DIR"] ?? "", "claude-args"), "utf8");
    assert.match(args, /^-p\nWrite AGENT.md\n/);
    assert.match(args, /--model\nopus\n--dangerously-skip-permissions\n$/);

    const blocked = await localRun(fixture, task);
    await blocked.exec("prepare");
    const signal = await localRunWithEnv(fixture, blocked, { FAKE_CLAUDE_MODE: "blocked" });
    assert.equal(signal.exitCode, 0, signal.output);
    assert.deepEqual(signal.data, { status: "blocked", reason: "needs a product call", question: "Keep the old API?" });
  });

  it("refuses to delete directories it did not create", async () => {
    await assert.rejects(localWorkerProvider().terminate({ kind: "local", dir: "/tmp" }), /refusing/);
    await assert.rejects(
      localWorkerProvider().terminate({ kind: "ec2", instanceId: "i-1", region: "r", instanceType: "t" }),
      /cannot drive/
    );
  });
});

async function localRunWithEnv(
  fixture: GitFixture,
  run: Awaited<ReturnType<typeof localRun>>,
  extra: NodeJS.ProcessEnv
) {
  const provider = localWorkerProvider({ root: fixture.root, env: { ...fixture.env, ...extra } });
  const result = await provider.exec(run.ref, "change", renderPhase("change", run.context), 60);
  return { ...result, data: parseResultLine(result.output) };
}
