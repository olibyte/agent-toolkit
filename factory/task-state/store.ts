import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PullRequest } from "../github/pr.ts";
import type { TaskSpec } from "../task.ts";
import type { WorkerRef } from "../worker/types.ts";
import { assertTransition, type RunState } from "./machine.ts";

export interface StateChange {
  readonly runId: string;
  readonly from: RunState | null;
  readonly to: RunState;
  readonly at: string;
  readonly reason: string | null;
}

export interface RunRecord {
  readonly id: string;
  readonly state: RunState;
  readonly task: TaskSpec;
  readonly branch: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly history: readonly Omit<StateChange, "runId">[];
  readonly worker: { readonly ref: WorkerRef; readonly terminatedAt: string | null } | null;
  readonly pr: PullRequest | null;
  readonly blocked: { readonly reason: string; readonly question: string | null } | null;
  readonly error: { readonly phase: string; readonly message: string } | null;
}

export type RunPatch = Partial<Pick<RunRecord, "worker" | "pr" | "blocked" | "error">>;

export interface RunStore {
  create(id: string, task: TaskSpec, branch: string): Promise<RunRecord>;
  get(id: string): Promise<RunRecord | null>;
  list(): Promise<readonly RunRecord[]>;
  update(id: string, patch: RunPatch): Promise<RunRecord>;
  transition(id: string, to: RunState, reason?: string): Promise<RunRecord>;
}

export interface RunStoreOptions {
  readonly now?: () => Date;
  readonly onChange?: (change: StateChange, run: RunRecord) => void;
}

interface StateFile {
  readonly version: 1;
  readonly runs: readonly RunRecord[];
  readonly [key: string]: unknown;
}

export class RunNotFoundError extends Error {
  override name = "RunNotFoundError";
}

async function readState(path: string): Promise<StateFile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, runs: [] };
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || (parsed as { version?: unknown }).version !== 1) {
    throw new Error(`${path}: expected a version 1 factory state file`);
  }
  const runs = (parsed as { runs?: unknown }).runs ?? [];
  if (!Array.isArray(runs)) throw new Error(`${path}: runs must be a list`);
  return { ...(parsed as object), version: 1, runs };
}

async function writeState(path: string, state: StateFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
  await rename(temporary, path);
}

export function openRunStore(path: string, options: RunStoreOptions = {}): RunStore {
  const now = options.now ?? (() => new Date());
  let queue: Promise<unknown> = Promise.resolve();

  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = queue.then(operation, operation);
    queue = next.catch(() => undefined);
    return next;
  }

  async function mutate(id: string, change: (run: RunRecord, at: string) => RunRecord): Promise<RunRecord> {
    const state = await readState(path);
    const index = state.runs.findIndex((run) => run.id === id);
    const current = state.runs[index];
    if (current === undefined) throw new RunNotFoundError(`no run ${id} in ${path}`);
    const next = change(current, now().toISOString());
    await writeState(path, { ...state, runs: state.runs.with(index, next) });
    return next;
  }

  return {
    create: (id, task, branch) =>
      exclusive(async () => {
        const state = await readState(path);
        if (state.runs.some((run) => run.id === id)) throw new Error(`run ${id} already exists`);
        const at = now().toISOString();
        const run: RunRecord = {
          id,
          state: "queued",
          task,
          branch,
          createdAt: at,
          updatedAt: at,
          history: [{ from: null, to: "queued", at, reason: null }],
          worker: null,
          pr: null,
          blocked: null,
          error: null,
        };
        await writeState(path, { ...state, runs: [...state.runs, run] });
        options.onChange?.({ runId: id, from: null, to: "queued", at, reason: null }, run);
        return run;
      }),

    get: (id) => exclusive(async () => (await readState(path)).runs.find((run) => run.id === id) ?? null),

    list: () => exclusive(async () => (await readState(path)).runs),

    update: (id, patch) =>
      exclusive(() => mutate(id, (run, at) => ({ ...run, ...patch, updatedAt: at }))),

    transition: (id, to, reason) =>
      exclusive(async () => {
        let change: StateChange | undefined;
        const run = await mutate(id, (current, at) => {
          assertTransition(current.state, to);
          change = { runId: id, from: current.state, to, at, reason: reason ?? null };
          const { runId: _runId, ...entry } = change;
          return { ...current, state: to, updatedAt: at, history: [...current.history, entry] };
        });
        if (change !== undefined) options.onChange?.(change, run);
        return run;
      }),
  };
}
