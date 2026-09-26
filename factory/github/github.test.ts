import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { gitFixture, type GitFixture } from "../fixtures.test-helper.ts";
import { PullRequestParseError, parsePullRequest } from "./pr.ts";
import { FACTORY_AUTHOR, checkoutScript, publishScript, taskBranch, type PublishOptions } from "./scripts.ts";

async function checkout(fixture: GitFixture, branch: string): Promise<string> {
  const repoDir = join(fixture.root, "work", "repo");
  const result = await fixture.bash(
    `set -euo pipefail\n${checkoutScript({ repo: fixture.repo, base: "main", branch, repoDir })}`
  );
  assert.equal(result.code, 0, result.stderr);
  return repoDir;
}

function publishOptions(fixture: GitFixture, repoDir: string, overrides: Partial<PublishOptions> = {}): PublishOptions {
  return {
    repo: fixture.repo,
    base: "main",
    branch: "factory/run-1",
    repoDir,
    title: "Add factory proof",
    commitTrailer: "Factory-Run: run-1",
    body: "Body with 'quotes' and $(not a command)",
    bodyFile: join(fixture.root, "work", "pr-body.md"),
    resultFile: join(fixture.root, "work", "publish.result.json"),
    autoMerge: false,
    ...overrides,
  };
}

async function publish(fixture: GitFixture, options: PublishOptions) {
  const result = await fixture.bash(`set -euo pipefail\n${publishScript(options)}`);
  return { result, pr: result.code === 0 ? parsePullRequest(JSON.parse(await readFile(options.resultFile, "utf8"))) : null };
}

describe("github publish flow", () => {
  it("branches, commits, pushes, and opens one PR with structured metadata", async () => {
    const fixture = await gitFixture();
    const branch = taskBranch("factory/", "run-1");
    const repoDir = await checkout(fixture, branch);
    await writeFile(join(repoDir, "PROOF.md"), "proof\n");

    const { result, pr } = await publish(fixture, publishOptions(fixture, repoDir));
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(pr, {
      number: 1,
      url: "https://github.com/owner/sandbox/pull/1",
      title: "Add factory proof",
      state: "OPEN",
      headRefName: "factory/run-1",
      baseRefName: "main",
      isDraft: false,
      autoMerge: false,
    });

    const pushed = await fixture.git("--git-dir", fixture.origin, "log", "-1", "--format=%an <%ae>|%s|%b", branch);
    assert.equal(pushed, `${FACTORY_AUTHOR.name} <${FACTORY_AUTHOR.email}>|Add factory proof|Factory-Run: run-1`);
    const gh = await fixture.gh();
    assert.equal(gh.prs[0]?.body, "Body with 'quotes' and $(not a command)\n");
    assert.deepEqual(gh.calls[0], ["auth", "setup-git"]);
  });

  it("reuses the open PR when publish runs again", async () => {
    const fixture = await gitFixture();
    const repoDir = await checkout(fixture, "factory/run-1");
    await writeFile(join(repoDir, "PROOF.md"), "proof\n");
    const options = publishOptions(fixture, repoDir);
    const first = await publish(fixture, options);
    const second = await publish(fixture, options);
    assert.equal(second.result.code, 0, second.result.stderr);
    assert.equal(second.pr?.url, first.pr?.url);
    assert.equal((await fixture.gh()).prs.length, 1);
  });

  it("enables auto-merge only when asked, and tolerates a repo that forbids it", async () => {
    const fixture = await gitFixture();
    const repoDir = await checkout(fixture, "factory/run-1");
    await writeFile(join(repoDir, "PROOF.md"), "proof\n");
    const { pr } = await publish(fixture, publishOptions(fixture, repoDir, { autoMerge: true }));
    assert.equal(pr?.autoMerge, true);

    const strict = await gitFixture();
    const strictDir = await checkout(strict, "factory/run-1");
    await writeFile(join(strictDir, "PROOF.md"), "proof\n");
    const script = `export FAKE_GH_MERGE_FAILS=1\nset -euo pipefail\n${publishScript(publishOptions(strict, strictDir, { autoMerge: true }))}`;
    const result = await strict.bash(script);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /could not enable auto-merge/);
  });

  it("refuses to publish a branch with no changes", async () => {
    const fixture = await gitFixture();
    const repoDir = await checkout(fixture, "factory/run-1");
    const { result } = await publish(fixture, publishOptions(fixture, repoDir));
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /nothing to publish/);
    assert.equal((await fixture.gh()).prs.length, 0);
  });
});

describe("parsePullRequest", () => {
  it("rejects unexpected gh output", () => {
    assert.throws(() => parsePullRequest([]), PullRequestParseError);
    assert.throws(
      () => parsePullRequest({ number: "1", url: "u", title: "t", state: "OPEN", headRefName: "h", baseRefName: "b", isDraft: false }),
      /number/
    );
    assert.throws(
      () => parsePullRequest({ number: 1, url: "u", title: "t", state: "DRAFT", headRefName: "h", baseRefName: "b", isDraft: false }),
      /state/
    );
  });
});
