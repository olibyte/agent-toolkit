import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runCommand } from "../exec.ts";
import { shq } from "../shell.ts";
import type { AgentHarness } from "../task.ts";
import type { WorkerProvider, WorkerRef } from "./types.ts";

const DIR_PREFIX = "agent-factory-";
const AGENT_BINARY: Readonly<Record<AgentHarness, string>> = { "claude-code": "claude", codex: "codex" };

export interface LocalWorkerOptions {
  readonly root?: string;
  readonly env?: NodeJS.ProcessEnv;
}

function requireTool(tool: string): string {
  return `command -v ${tool} >/dev/null || { echo ${shq(`local worker needs ${tool} on PATH`)} >&2; exit 1; }`;
}

function localRef(ref: WorkerRef): Extract<WorkerRef, { kind: "local" }> {
  if (ref.kind !== "local") throw new Error(`local worker cannot drive a ${ref.kind} worker`);
  return ref;
}

export function localWorkerProvider(options: LocalWorkerOptions = {}): WorkerProvider {
  const env = options.env ?? process.env;
  return {
    async launch(runId) {
      return { kind: "local", dir: await mkdtemp(join(options.root ?? tmpdir(), `${DIR_PREFIX}${runId}-`)) };
    },

    async ready() {},

    environment(ref) {
      const { dir } = localRef(ref);
      return {
        workdir: dir,
        preamble: [
          `export GIT_CONFIG_GLOBAL=${shq(`${dir}/gitconfig`)}`,
          "factory_secret() { return 1; }",
          'factory_task() { bash -c "$1"; }',
          "factory_task_owns() { :; }",
        ].join("\n"),
        githubAuth: 'GH_TOKEN="${GH_TOKEN:-$(gh auth token)}"\nexport GH_TOKEN',
        setup: [requireTool("git"), requireTool("gh")].join("\n"),
        installPackages: (packages) =>
          `echo ${shq(`local worker skips packages, so install them on this machine if the task needs them: ${packages.join(" ")}`)}`,
        agentSetup: (harness) => requireTool(AGENT_BINARY[harness]),
      };
    },

    async exec(ref, _phase, script, timeoutSeconds) {
      const { dir } = localRef(ref);
      const result = await runCommand(["bash", "-s"], {
        cwd: dir,
        env,
        input: script,
        timeoutMs: timeoutSeconds * 1000,
      });
      return {
        exitCode: result.timedOut ? 124 : result.code,
        output: `${result.stdout}${result.stderr}${result.timedOut ? `\nphase timed out after ${timeoutSeconds}s` : ""}`,
      };
    },

    async terminate(ref) {
      const { dir } = localRef(ref);
      if (!basename(dir).startsWith(DIR_PREFIX)) throw new Error(`refusing to delete ${dir}`);
      await rm(dir, { recursive: true, force: true });
    },
  };
}
