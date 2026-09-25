import type { PullRequest } from "../github/pr.ts";
import type { WorkerRef } from "../worker/types.ts";

interface EventBase {
  readonly runId: string;
  readonly at: string;
  readonly repo: string;
}

export type FactoryEvent = EventBase &
  (
    | { readonly type: "factory.started"; readonly title: string; readonly branch: string }
    | {
        readonly type: "factory.completed";
        readonly outcome: "completed" | "failed" | "blocked";
        readonly pr: PullRequest | null;
        readonly error: string | null;
      }
    | { readonly type: "worker.started"; readonly worker: WorkerRef }
    | { readonly type: "worker.failed"; readonly phase: string; readonly error: string }
    | { readonly type: "agent.blocked"; readonly reason: string }
    | { readonly type: "agent.question"; readonly question: string }
    | { readonly type: "pr.opened"; readonly pr: PullRequest }
    | { readonly type: "pr.merged"; readonly pr: PullRequest }
    | {
        readonly type: "deploy.failed";
        readonly environment: string;
        readonly error: string;
        readonly url: string | null;
      }
    | { readonly type: "deploy.succeeded"; readonly environment: string; readonly url: string | null }
  );

export type EventType = FactoryEvent["type"];
