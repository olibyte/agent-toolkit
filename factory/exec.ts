import { spawn } from "node:child_process";

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface RunOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
  readonly timeoutMs?: number;
}

export type CommandRunner = (
  argv: readonly [string, ...string[]],
  options?: RunOptions
) => Promise<CommandResult>;

export const runCommand: CommandRunner = (argv, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
          }, options.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
    child.stdin.end(options.input ?? "");
  });

export function firstLine(value: string): string {
  return value.trim().split(/\r?\n/, 1)[0]?.slice(0, 300) ?? "";
}
