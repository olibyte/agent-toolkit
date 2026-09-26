#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fanout, jsonLinesNotifier, type Notifier } from "./notifications/notifier.ts";
import { formatSlackMessage, slackWebhookNotifier } from "./notifications/slack.ts";
import { runTask } from "./orchestrator.ts";
import { writeRunSummary } from "./run-summary.ts";
import { isTerminal } from "./task-state/machine.ts";
import { openRunStore, type RunRecord, type RunStore } from "./task-state/store.ts";
import { parseTask } from "./task.ts";
import { awsCli, configuredRegion, ec2WorkerProvider, loadEc2Config, terminateInstance } from "./worker/ec2.ts";
import { localWorkerProvider } from "./worker/local.ts";
import { describeWorker, type WorkerProvider, type WorkerRef } from "./worker/types.ts";

const USAGE = `usage: node factory/cli.ts <command> [options]

commands:
  run <task.json> --worker local|ec2   run one task end to end
  status [run-id]                      list runs, or print one run as JSON
  cleanup <run-id>                     terminate a leftover worker and fail an unfinished run

options:
  --state-dir DIR        run records go to DIR/runs/ (default .factory)
  --profile PROFILE      AWS CLI profile (default $FACTORY_AWS_PROFILE, then the AWS default chain)
  --region REGION        AWS region (default $AWS_REGION, $AWS_DEFAULT_REGION, then the profile's region)
  --name NAME            name prefix used by factory/infra (default agent-factory)
  --instance-type TYPE   EC2 instance type (default t3.small)

environment:
  FACTORY_SLACK_WEBHOOK_URL   Slack Incoming Webhook URL. Unset means console output only.
  FACTORY_AWS_PROFILE         AWS profile for factory commands only, so other tools keep their own.
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

function runPaths(stateDir: string) {
  const runs = join(stateDir, "runs");
  return { runs, state: join(runs, "state.json"), summary: join(runs, "last-run.md") };
}

export function newRunId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${stamp}-${randomBytes(2).toString("hex")}`;
}

interface AwsFlags {
  readonly profile?: string;
  readonly region?: string;
}

function awsProfile(flags: AwsFlags): string | null {
  const profile = flags.profile ?? process.env["FACTORY_AWS_PROFILE"];
  return profile === undefined || profile === "" ? null : profile;
}

async function awsRegion(flags: AwsFlags): Promise<string> {
  const resolved =
    flags.region ||
    process.env["AWS_REGION"] ||
    process.env["AWS_DEFAULT_REGION"] ||
    (await configuredRegion(undefined, awsProfile(flags)));
  if (!resolved) throw new UsageError("set --region, AWS_REGION, or a region on the AWS profile");
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

function terminatorFor(ref: WorkerRef, profile: string | null): (ref: WorkerRef) => Promise<void> {
  return ref.kind === "local"
    ? (target) => localWorkerProvider().terminate(target)
    : (target) => terminateInstance({ aws: awsCli(undefined, profile) }, target);
}

export interface CleanupOptions {
  readonly waitForLaunchMs?: number;
  readonly profile?: string | null;
}

export async function cleanup(
  store: RunStore,
  runId: string,
  reason: string,
  options: CleanupOptions = {}
): Promise<RunRecord> {
  let run = await store.get(runId);
  if (run === null) throw new UsageError(`no run ${runId}`);
  const deadline = Date.now() + (options.waitForLaunchMs ?? 0);
  while (run.worker === null && run.state === "provisioning" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    run = (await store.get(runId)) ?? run;
  }
  if (run.worker !== null && run.worker.terminatedAt === null) {
    const { ref } = run.worker;
    await terminatorFor(ref, options.profile ?? null)(ref);
    run = await store.update(runId, { worker: { ref, terminatedAt: new Date().toISOString() } });
  }
  if (!isTerminal(run.state)) {
    if (run.error === null) run = await store.update(runId, { error: { phase: "cleanup", message: reason } });
    run = await store.transition(runId, "failed", reason);
  }
  return run;
}

type RunFlags = AwsFlags & Readonly<Partial<Record<"worker" | "name" | "instance-type", string>>>;

async function runTaskCommand(positionals: readonly string[], values: RunFlags, io: Io, stateDir: string) {
  const [taskPath] = positionals;
  if (taskPath === undefined) throw new UsageError("run needs a task file");
  if (values.worker !== "local" && values.worker !== "ec2") throw new UsageError("run needs --worker local or --worker ec2");
  const task = parseTask(JSON.parse(await readFile(taskPath, "utf8")));
  const runId = newRunId(new Date());
  const paths = runPaths(stateDir);
  const runDir = join(paths.runs, runId);
  mkdirSync(runDir, { recursive: true });
  const eventsFile = join(runDir, "events.jsonl");

  const store = openRunStore(paths.state, {
    onChange: (change) => {
      appendFileSync(eventsFile, `${JSON.stringify({ type: "state.changed", ...change })}\n`);
      io.stderr(`[factory] state ${change.from ?? "new"} -> ${change.to}${change.reason ? ` (${change.reason})` : ""}\n`);
    },
  });

  let worker: WorkerProvider;
  if (values.worker === "local") {
    worker = localWorkerProvider();
  } else {
    const aws = awsCli(undefined, awsProfile(values));
    const config = await loadEc2Config(aws, {
      region: await awsRegion(values),
      name: values.name ?? "agent-factory",
      instanceType: values["instance-type"] ?? "t3.small",
    });
    worker = ec2WorkerProvider(config, { aws });
  }

  process.once("SIGINT", () => {
    io.stderr(`[factory] interrupted, cleaning up run ${runId}\n`);
    cleanup(store, runId, "interrupted by operator", { waitForLaunchMs: 60_000, profile: awsProfile(values) })
      .then((run) => writeRunSummary(paths.summary, run))
      .finally(() => process.exit(130));
  });

  io.stderr(`[factory] run ${runId} on ${values.worker} worker\n`);
  const run = await runTask(
    {
      store,
      worker,
      notifier: notifierFor(io, eventsFile),
      saveLog: (id, name, output) => writeFile(join(paths.runs, id, `${name}.log`), output),
    },
    task,
    runId
  );
  await writeRunSummary(paths.summary, run);
  io.stdout(`${JSON.stringify(run, null, 2)}\n`);
  return run.state === "completed" ? EXIT.completed : run.state === "blocked" ? EXIT.blocked : EXIT.failed;
}

async function statusCommand(positionals: readonly string[], io: Io, stateDir: string) {
  const store = openRunStore(runPaths(stateDir).state);
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
        profile: { type: "string" },
        name: { type: "string" },
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
      const paths = runPaths(stateDir);
      const run = await cleanup(openRunStore(paths.state), runId, "abandoned: cleaned up by operator", {
        profile: awsProfile(values),
      });
      await writeRunSummary(paths.summary, run);
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
