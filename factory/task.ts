export const AGENT_HARNESSES = ["claude-code", "codex"] as const;
export type AgentHarness = (typeof AGENT_HARNESSES)[number];

export const DEFAULT_AGENT_MODEL: Readonly<Record<AgentHarness, string | null>> = {
  "claude-code": "sonnet",
  codex: null,
};

export type Change =
  | { readonly kind: "shell"; readonly run: string }
  | {
      readonly kind: "agent";
      readonly harness: AgentHarness;
      readonly prompt: string;
      readonly model: string | null;
      readonly escalationModel: string | null;
    };

export interface TaskSpec {
  readonly repo: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
  readonly packages: readonly string[];
  readonly setup: readonly string[];
  readonly change: Change;
  readonly verify: readonly string[];
  readonly autoMerge: boolean;
  readonly branchPrefix: string;
}

export class TaskSpecError extends Error {
  override name = "TaskSpecError";
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REF = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]+$/;
const PACKAGE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(source: Record<string, unknown>, key: string, fallback?: string): string {
  const value = source[key] ?? fallback;
  if (typeof value !== "string" || value.trim() === "") {
    throw new TaskSpecError(`${key} must be a non-empty string`);
  }
  return value;
}

function optionalText(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw new TaskSpecError(`${key} must be a non-empty string when set`);
  }
  return value;
}

function ref(source: Record<string, unknown>, key: string, fallback: string): string {
  const value = text(source, key, fallback);
  if (!REF.test(value)) throw new TaskSpecError(`${key} is not a safe git ref: ${value}`);
  return value;
}

function commands(source: Record<string, unknown>, key: string, required: boolean): readonly string[] {
  const value = source[key] ?? [];
  if (
    !Array.isArray(value) ||
    (required && value.length === 0) ||
    value.some((command) => typeof command !== "string" || command.trim() === "")
  ) {
    throw new TaskSpecError(`${key} must be a ${required ? "non-empty " : ""}list of shell commands`);
  }
  return value;
}

function parseChange(value: unknown): Change {
  if (!isRecord(value)) throw new TaskSpecError("change must be an object");
  if (value["kind"] === "shell") return { kind: "shell", run: text(value, "run") };
  if (value["kind"] === "agent") {
    const harness = value["harness"];
    if (!AGENT_HARNESSES.some((candidate) => candidate === harness)) {
      throw new TaskSpecError(`change.harness must be one of ${AGENT_HARNESSES.join(", ")}`);
    }
    const typedHarness = harness as AgentHarness;
    return {
      kind: "agent",
      harness: typedHarness,
      prompt: text(value, "prompt"),
      model: optionalText(value, "model") ?? DEFAULT_AGENT_MODEL[typedHarness],
      escalationModel: optionalText(value, "escalationModel"),
    };
  }
  throw new TaskSpecError('change.kind must be "shell" or "agent"');
}

export function parseTask(value: unknown): TaskSpec {
  if (!isRecord(value)) throw new TaskSpecError("task must be a JSON object");
  const repo = text(value, "repo");
  if (!REPO.test(repo)) throw new TaskSpecError(`repo must look like owner/name: ${repo}`);
  const packages = value["packages"] ?? [];
  if (!Array.isArray(packages) || packages.some((name) => typeof name !== "string" || !PACKAGE.test(name))) {
    throw new TaskSpecError("packages must be a list of package names");
  }
  const autoMerge = value["autoMerge"] ?? false;
  if (typeof autoMerge !== "boolean") throw new TaskSpecError("autoMerge must be a boolean");
  const title = text(value, "title");
  return {
    repo,
    base: ref(value, "base", "main"),
    title,
    body: text(value, "body", title),
    packages,
    setup: commands(value, "setup", false),
    change: parseChange(value["change"]),
    verify: commands(value, "verify", true),
    autoMerge,
    branchPrefix: ref(value, "branchPrefix", "factory/"),
  };
}
