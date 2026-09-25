import { firstLine } from "../exec.ts";
import type { PullRequest } from "../github/pr.ts";
import { describeWorker } from "../worker/types.ts";
import type { FactoryEvent } from "./events.ts";
import type { Notifier } from "./notifier.ts";

export interface SlackWebhookOptions {
  readonly webhookUrl: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface SlackMessage {
  readonly text: string;
}

function escape(value: string, limit = 500): string {
  const clipped = value.length > limit ? `${value.slice(0, limit)}…` : value;
  return clipped.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function prLink(pr: PullRequest): string {
  return `<${pr.url}|#${pr.number} ${escape(pr.title, 120)}>`;
}

function headline(event: FactoryEvent): string {
  const run = `\`${event.runId}\``;
  const repo = escape(event.repo);
  switch (event.type) {
    case "factory.started":
      return `:factory: Run ${run} started on ${repo}: ${escape(event.title)}`;
    case "factory.completed":
      if (event.outcome === "completed") {
        return `:white_check_mark: Run ${run} completed on ${repo}${event.pr ? ` · ${prLink(event.pr)}` : ""}`;
      }
      if (event.outcome === "blocked") return `:double_vertical_bar: Run ${run} on ${repo} is blocked`;
      return `:x: Run ${run} failed on ${repo}: ${escape(event.error ?? "unknown error")}`;
    case "worker.started":
      return `:gear: Worker ${escape(describeWorker(event.worker))} started for run ${run}`;
    case "worker.failed":
      return `:rotating_light: Worker failed during *${escape(event.phase)}* for run ${run}: ${escape(event.error)}`;
    case "agent.blocked":
      return `:no_entry: Agent blocked on run ${run}: ${escape(event.reason)}`;
    case "agent.question":
      return `:question: Agent question on run ${run}: ${escape(event.question)}`;
    case "pr.opened":
      return `:arrow_heading_up: PR ${prLink(event.pr)} opened on ${repo} by run ${run}`;
    case "pr.merged":
      return `:tada: PR ${prLink(event.pr)} merged on ${repo}`;
    case "deploy.failed":
      return `:fire: Deploy to ${escape(event.environment)} failed for run ${run}: ${escape(event.error)}${event.url ? ` <${event.url}|details>` : ""}`;
    case "deploy.succeeded":
      return `:rocket: Deploy to ${escape(event.environment)} succeeded for run ${run}${event.url ? ` <${event.url}|open>` : ""}`;
  }
}

export function formatSlackMessage(event: FactoryEvent): SlackMessage {
  return { text: `${headline(event)}\n_${event.type}_` };
}

export function slackWebhookNotifier(options: SlackWebhookOptions): Notifier {
  let url: URL;
  try {
    url = new URL(options.webhookUrl);
  } catch {
    throw new Error("Slack webhook URL is not a valid URL");
  }
  if (url.protocol !== "https:") throw new Error("Slack webhook URL must use https");
  const post = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  return {
    async notify(event) {
      let response: Response;
      try {
        response = await post(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(formatSlackMessage(event)),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.name : "unknown error";
        throw new Error(`Slack webhook request failed (${reason})`);
      }
      if (!response.ok) {
        throw new Error(`Slack webhook responded ${response.status}: ${firstLine(await response.text())}`);
      }
    },
  };
}
