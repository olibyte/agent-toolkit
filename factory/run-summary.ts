import { writeFile } from "node:fs/promises";
import type { RunRecord } from "./task-state/store.ts";
import { describeWorker } from "./worker/types.ts";

export function renderRunSummary(run: RunRecord): string {
  const worker =
    run.worker === null
      ? "never launched"
      : run.worker.terminatedAt === null
        ? `${describeWorker(run.worker.ref)}, **not terminated**: run \`node factory/cli.ts cleanup ${run.id}\``
        : `${describeWorker(run.worker.ref)}, terminated ${run.worker.terminatedAt}`;
  const lines = [
    "# Last factory run",
    "",
    "Written by `factory/cli.ts` after every run. Full history: `.factory/runs/state.json`.",
    "",
    `- Run: \`${run.id}\` is **${run.state}**`,
    `- Task: ${run.task.title} (${run.task.repo}, \`${run.task.base}\` to \`${run.branch}\`)`,
    `- Worker: ${worker}`,
    `- PR: ${run.pr === null ? "none" : `[#${run.pr.number}](${run.pr.url}), ${run.pr.state.toLowerCase()}${run.pr.autoMerge ? ", auto-merge on" : ""}`}`,
  ];
  if (run.blocked !== null) {
    lines.push(`- Blocked: ${run.blocked.reason}${run.blocked.question === null ? "" : `. Question: ${run.blocked.question}`}`);
  }
  if (run.error !== null) lines.push(`- Error (${run.error.phase}): ${run.error.message}`);
  lines.push(
    `- States: ${run.history.map((entry) => entry.to).join(" → ")}`,
    `- Time: ${run.createdAt} to ${run.updatedAt}`,
    `- Logs: \`.factory/runs/${run.id}/\``
  );
  return `${lines.join("\n")}\n`;
}

export async function writeRunSummary(path: string, run: RunRecord): Promise<void> {
  await writeFile(path, renderRunSummary(run));
}
