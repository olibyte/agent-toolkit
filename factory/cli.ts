#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { updateHandoff } from "./handoff.ts";
import { fanout, jsonLinesNotifier, type Notifier } from "./notifications/notifier.ts";
import { formatSlackMessage, slackWebhookNotifier } from "./notifications/slack.ts";
import { runTask } from "./orchestrator.ts";
import { isTerminal } from "./task-state/machine.ts";
import { openRunStore, type RunRecord, type RunStore } from "./task-state/store.ts";
import { parseTask } from "./task.ts";
import { awsCli, ec2WorkerProvider, loadEc2Config, terminateInstance } from "./worker/ec2.ts";
import { localWorkerProvider } from "./worker/local.ts";
import { describeWorker, type WorkerProvider, type WorkerRef } from "./worker/types.ts";

const USAGE = `usage: node factory/cli.ts <command> [options]

commands:
  run <task.json> --worker local|ec2   run one task end to end
  status [run-id]                      list runs, or print one run as JSON
  cleanup <run-id>                     terminate a leftover worker and fail an unfinished run

options:
  --state-dir DIR        coordination directory (default .factory)
  --region REGION        AWS region (default $AWS_REGION, then $AWS_DEFAULT_REGION)
  --stack NAME           CloudFormation stack with worker settings (default agent-factory)
  --instance-type TYPE   EC2 instance type (default t3.small)

environment:
  FACTORY_SLACK_WEBHOOK_URL   Slack Incoming Webhook URL. Unset means console output only.
`;

const EXIT = { completed: 0, failed: 1, usage: 2, blocked: 3 } as const;

interface Io {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const processIo: Io = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

class UsageError extends Error {}

export function newRunId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${stamp}-${randomBytes(2).toString("hex")}`;
}

function region(value: string | undefined): string {
  const resolved = value ?? process.env["AWS_REGION"] ?? process.env["AWS_DEFAULT_REGION"];
  if (resolved === undefined || resolved === "") throw new UsageError("set --region or AWS_REGION for ec2 workers");
  return resolved;
}

function consoleNotifier(io: Io): Notifier {
  return {
    async notify(event) {
      const headline = formatSlackMessage(event).text.split("\n")[0]?.replace(/^:[a-z_]+: /, "") ?? "";
      io.stderr(`[factory] ${event.type}: ${headline}\n`);
    },
  };
}

function notifierFor(io: Io, eventsFile: string): Notifier {
  const notifiers = [consoleNotifier(io), jsonLinesNotifier((line) => appendFileSync(eventsFile, line))];
  const webhookUrl = process.env["FACTORY_SLACK_WEBHOOK_URL"];
  if (webhookUrl === undefined || webhookUrl === "") {
    io.stderr("[factory] FACTORY_SLACK_WEBHOOK_URL is not set, so notifications go to the console only\n");
  } else {
    notifiers.push(slackWebhookNotifier({ webhookUrl }));
  }
  return fanout(notifiers, (error, event) =>
    io.stderr(`[factory] notification ${event.type} failed: ${error instanceof Error ? error.message : String(error)}\n`)
  );
}

function terminatorFor(ref: WorkerRef): (ref: WorkerRef) => Promise<void> {
  return ref.kind === "local"
    ? (target) => localWorkerProvider().terminate(target)
    : (target) => terminateInstance({ aws: awsCli() }, target);
}

export async function cleanup(store: RunStore, runId: string, reason: string, waitForLaunchMs = 0): Promise<RunRecord> {
  let run = await store.get(runId);
  if (run === null) throw new UsageError(`no run ${runId}`);
  const deadline = Date.now() + waitForLaunchMs;
  while (run.worker === null && run.state === "provisioning" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    run = (await store.get(runId)) ?? run;
  }
  if (run.worker !== null && run.worker.terminatedAt === null) {
    const { ref } = run.worker;
    await terminatorFor(ref)(ref);
    run = await store.update(runId, { worker: { ref, terminatedAt: new Date().toISOString() } });
  }
  if (!isTerminal(run.state)) {
    if (run.error === null) run = await store.update(runId, { error: { phase: "cleanup", message: reason } });
    run = await store.transition(runId, "failed", reason);
  }
  return run;
}

type RunFlags = Readonly<Partial<Record<"worker" | "region" | "stack" | "instance-type", string>>>;

async function runTaskCommand(positionals: readonly string[], values: RunFlags, io: Io, stateDir: string) {
  const [taskPath] = positionals;
  if (taskPath === undefined) throw new UsageError("run needs a task file");
  if (values.worker !== "local" && values.worker !== "ec2") throw new UsageError("run needs --worker local or --worker ec2");
  const task = parseTask(JSON.parse(await readFile(taskPath, "utf8")));
  const runId = newRunId(new Date());
  const runDir = join(stateDir, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  const eventsFile = join(runDir, "events.jsonl");

  const store = openRunStore(join(stateDir, "state.json"), {
    onChange: (change) => {
      appendFileSync(eventsFile, `${JSON.stringify({ type: "state.changed", ...change })}\n`);
      io.stderr(`[factory] state ${change.from ?? "new"} -> ${change.to}${change.reason ? ` (${change.reason})` : ""}\n`);
    },
  });

  let worker: WorkerProvider;
  if (values.worker === "local") {
    worker = localWorkerProvider();
  } else {
    const aws = awsCli();
    const config = await loadEc2Config(aws, {
      region: region(values.region),
      stack: values.stack ?? "agent-factory",
      instanceType: values["instance-type"] ?? "t3.small",
    });
    worker = ec2WorkerProvider(config, { aws });
  }

  process.once("SIGINT", () => {
    io.stderr(`[factory] interrupted, cleaning up run ${runId}\n`);
    cleanup(store, runId, "interrupted by operator", 60_000)
      .then((run) => updateHandoff(join(stateDir, "handoff.md"), run))
      .finally(() => process.exit(130));
  });

  io.stderr(`[factory] run ${runId} on ${values.worker} worker\n`);
  const run = await runTask(
    {
      store,
      worker,
      notifier: notifierFor(io, eventsFile),
      saveLog: (id, name, output) => writeFile(join(stateDir, "runs", id, `${name}.log`), output),
    },
    task,
    runId
  );
  await updateHandoff(join(stateDir, "handoff.md"), run);
  io.stdout(`${JSON.stringify(run, null, 2)}\n`);
  return run.state === "completed" ? EXIT.completed : run.state === "blocked" ? EXIT.blocked : EXIT.failed;
}

async function statusCommand(positionals: readonly string[], io: Io, stateDir: string) {
  const store = openRunStore(join(stateDir, "state.json"));
  const [runId] = positionals;
  if (runId !== undefined) {
    const run = await store.get(runId);
    if (run === null) throw new UsageError(`no run ${runId}`);
    io.stdout(`${JSON.stringify(run, null, 2)}\n`);
    return EXIT.completed;
  }
  for (const run of await store.list()) {
    const worker = run.worker === null ? "-" : `${describeWorker(run.worker.ref)}${run.worker.terminatedAt ? "" : " LIVE"}`;
    io.stdout(`${run.id}  ${run.state.padEnd(12)}  ${run.pr?.url ?? "-"}  ${worker}\n`);
  }
  return EXIT.completed;
}

export async function main(argv: readonly string[], io: Io = processIo): Promise<number> {
  try {
    const { positionals, values } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        worker: { type: "string" },
        "state-dir": { type: "string" },
        region: { type: "string" },
        stack: { type: "string" },
        "instance-type": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
    const [command, ...rest] = positionals;
    const stateDir = values["state-dir"] ?? ".factory";
    if (values.help || command === undefined) {
      io.stdout(USAGE);
      return values.help ? EXIT.completed : EXIT.usage;
    }
    if (command === "run") return await runTaskCommand(rest, values, io, stateDir);
    if (command === "status") return await statusCommand(rest, io, stateDir);
    if (command === "cleanup") {
      const [runId] = rest;
      if (runId === undefined) throw new UsageError("cleanup needs a run id");
      const run = await cleanup(openRunStore(join(stateDir, "state.json")), runId, "abandoned: cleaned up by operator");
      await updateHandoff(join(stateDir, "handoff.md"), run);
      io.stdout(`${JSON.stringify(run, null, 2)}\n`);
      return EXIT.completed;
    }
    throw new UsageError(`unknown command ${command}`);
  } catch (error) {
    io.stderr(`factory: ${error instanceof Error ? error.message : String(error)}\n`);
    if (error instanceof UsageError || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      io.stderr(USAGE);
      return EXIT.usage;
    }
    return EXIT.failed;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
