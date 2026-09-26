import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PullRequest } from "../github/pr.ts";
import type { EventType, FactoryEvent } from "./events.ts";
import { fanout, jsonLinesNotifier, type Notifier } from "./notifier.ts";
import { formatSlackMessage, slackWebhookNotifier } from "./slack.ts";

const WEBHOOK = "https://hooks.slack.com/services/T000/B000/secret-token";
const base = { runId: "run-1", at: "2026-09-25T12:00:00.000Z", repo: "owner/sandbox" };
const pr: PullRequest = {
  number: 7,
  url: "https://github.com/owner/sandbox/pull/7",
  title: "Add <proof> & more",
  state: "OPEN",
  headRefName: "factory/run-1",
  baseRefName: "main",
  isDraft: false,
  autoMerge: false,
};

const samples: { readonly [K in EventType]: Extract<FactoryEvent, { type: K }> } = {
  "factory.started": { ...base, type: "factory.started", title: "Trivial change", branch: "factory/run-1" },
  "factory.completed": { ...base, type: "factory.completed", outcome: "completed", pr, error: null },
  "worker.started": {
    ...base,
    type: "worker.started",
    worker: { kind: "ec2", instanceId: "i-123", region: "us-east-1", instanceType: "t3.small" },
  },
  "worker.failed": { ...base, type: "worker.failed", phase: "verify", error: "exit 1" },
  "agent.blocked": { ...base, type: "agent.blocked", reason: "needs a product call" },
  "agent.question": { ...base, type: "agent.question", question: "Which base branch?" },
  "pr.opened": { ...base, type: "pr.opened", pr },
  "pr.merged": { ...base, type: "pr.merged", pr: { ...pr, state: "MERGED" } },
  "deploy.failed": { ...base, type: "deploy.failed", environment: "staging", error: "boom", url: null },
  "deploy.succeeded": {
    ...base,
    type: "deploy.succeeded",
    environment: "staging",
    url: "https://staging.example.com",
  },
};

function recordingFetch(status = 200, body = "ok") {
  const calls: { url: string; init: RequestInit }[] = [];
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(body, { status });
  }) as typeof fetch;
  return { fake, calls };
}

describe("slack formatting", () => {
  it("renders a labelled message for every event type", () => {
    for (const event of Object.values(samples)) {
      const { text } = formatSlackMessage(event);
      assert.match(text, /run-1|#7/, event.type);
      assert.ok(text.endsWith(`_${event.type}_`), event.type);
    }
  });

  it("escapes Slack control characters and links the PR", () => {
    const { text } = formatSlackMessage(samples["pr.opened"]);
    assert.match(text, /<https:\/\/github.com\/owner\/sandbox\/pull\/7\|#7 Add &lt;proof&gt; &amp; more>/);
  });

  it("reports failure and blocked outcomes distinctly", () => {
    const failed = formatSlackMessage({ ...samples["factory.completed"], outcome: "failed", pr: null, error: "verify exit 1" });
    const blocked = formatSlackMessage({ ...samples["factory.completed"], outcome: "blocked", pr: null });
    assert.match(failed.text, /^:x: .*verify exit 1/);
    assert.match(blocked.text, /is blocked/);
  });
});

describe("slack webhook notifier", () => {
  it("posts the formatted message as JSON", async () => {
    const { fake, calls } = recordingFetch();
    await slackWebhookNotifier({ webhookUrl: WEBHOOK, fetch: fake }).notify(samples["factory.started"]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, WEBHOOK);
    assert.equal(calls[0]?.init.method, "POST");
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), formatSlackMessage(samples["factory.started"]));
  });

  it("never puts the webhook URL in errors", async () => {
    const rejected = recordingFetch(403, "invalid_token");
    await assert.rejects(
      slackWebhookNotifier({ webhookUrl: WEBHOOK, fetch: rejected.fake }).notify(samples["pr.opened"]),
      (error: Error) => error.message.includes("403") && !error.message.includes("secret-token")
    );
    const offline = (async () => {
      throw new TypeError(`fetch failed for ${WEBHOOK}`);
    }) as typeof fetch;
    await assert.rejects(
      slackWebhookNotifier({ webhookUrl: WEBHOOK, fetch: offline }).notify(samples["pr.opened"]),
      (error: Error) => !error.message.includes("secret-token")
    );
    assert.throws(() => slackWebhookNotifier({ webhookUrl: "http://hooks.slack.com/x" }), /https/);
  });
});

describe("fanout", () => {
  it("delivers to every notifier and reports failures without throwing", async () => {
    const lines: string[] = [];
    const failures: string[] = [];
    const broken: Notifier = {
      notify: async () => {
        throw new Error("down");
      },
    };
    const notifier = fanout([broken, jsonLinesNotifier((line) => lines.push(line))], (error, event) =>
      failures.push(`${event.type}: ${(error as Error).message}`)
    );
    await notifier.notify(samples["worker.failed"]);
    assert.deepEqual(failures, ["worker.failed: down"]);
    assert.equal(JSON.parse(lines[0] ?? "").type, "worker.failed");
  });
});
