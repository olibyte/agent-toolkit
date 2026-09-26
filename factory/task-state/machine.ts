export const RUN_STATES = [
  "queued",
  "provisioning",
  "running",
  "blocked",
  "verifying",
  "pr_opened",
  "completed",
  "failed",
] as const;
export type RunState = (typeof RUN_STATES)[number];

export const TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  queued: ["provisioning", "failed"],
  provisioning: ["running", "failed"],
  running: ["blocked", "verifying", "failed"],
  blocked: ["provisioning", "running", "failed"],
  verifying: ["running", "pr_opened", "failed"],
  pr_opened: ["completed", "failed"],
  completed: [],
  failed: [],
};

export class InvalidTransitionError extends Error {
  override name = "InvalidTransitionError";
  readonly from: RunState;
  readonly to: RunState;

  constructor(from: RunState, to: RunState) {
    super(`invalid run transition ${from} -> ${to}`);
    this.from = from;
    this.to = to;
  }
}

export function canTransition(from: RunState, to: RunState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: RunState, to: RunState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function isTerminal(state: RunState): boolean {
  return TRANSITIONS[state].length === 0;
}
