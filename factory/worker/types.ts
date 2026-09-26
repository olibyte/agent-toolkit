import type { AgentHarness } from "../task.ts";

export type WorkerRef =
  | { readonly kind: "local"; readonly dir: string }
  | {
      readonly kind: "ec2";
      readonly instanceId: string;
      readonly region: string;
      readonly instanceType: string;
    };

export const PHASES = ["prepare", "change", "verify", "publish"] as const;
export type Phase = (typeof PHASES)[number];

export interface PhaseResult {
  readonly exitCode: number;
  readonly output: string;
}

export interface WorkerEnvironment {
  readonly workdir: string;
  readonly preamble: string;
  readonly githubAuth: string;
  readonly setup: string;
  agentSetup(harness: AgentHarness): string;
}

export interface WorkerProvider {
  launch(runId: string): Promise<WorkerRef>;
  ready(ref: WorkerRef): Promise<void>;
  environment(ref: WorkerRef): WorkerEnvironment;
  exec(ref: WorkerRef, phase: Phase, script: string, timeoutSeconds: number): Promise<PhaseResult>;
  terminate(ref: WorkerRef): Promise<void>;
}

export function describeWorker(ref: WorkerRef): string {
  return ref.kind === "ec2"
    ? `ec2 ${ref.instanceId} (${ref.region}, ${ref.instanceType})`
    : `local ${ref.dir}`;
}
