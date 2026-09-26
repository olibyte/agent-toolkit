import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, type CommandResult } from "./exec.ts";

const FAKE_GH = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = process.env.FAKE_GH_DIR;
const statePath = path.join(dir, "state.json");
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { prs: [], calls: [] };
const args = process.argv.slice(2);
state.calls.push(args);
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
const view = (pr) => ({ number: pr.number, url: pr.url, title: pr.title, state: pr.state, headRefName: pr.head,
  baseRefName: pr.base, isDraft: false, autoMergeRequest: pr.autoMerge ? { mergeMethod: "SQUASH" } : null });
const [group, command] = args;
if (group === "auth") { if (command === "token") console.log("fake-token"); save(); process.exit(0); }
if (group === "pr" && command === "list") {
  const pr = state.prs.find((candidate) => candidate.head === flag("--head") && candidate.state === "OPEN");
  if (pr) console.log(pr.url);
  save(); process.exit(0);
}
if (group === "pr" && command === "create") {
  const number = state.prs.length + 1;
  const pr = { number, url: "https://github.com/" + flag("--repo") + "/pull/" + number, title: flag("--title"),
    head: flag("--head"), base: flag("--base"), body: fs.readFileSync(flag("--body-file"), "utf8"), state: "OPEN", autoMerge: false };
  state.prs.push(pr); save(); console.log(pr.url); process.exit(0);
}
if (group === "pr" && (command === "view" || command === "merge")) {
  const pr = state.prs.find((candidate) => candidate.url === args[2]);
  if (!pr) { console.error("no pull request " + args[2]); save(); process.exit(1); }
  if (command === "merge") { if (process.env.FAKE_GH_MERGE_FAILS) { console.error("auto-merge not allowed"); save(); process.exit(1); } pr.autoMerge = true; }
  else console.log(JSON.stringify(view(pr)));
  save(); process.exit(0);
}
console.error("fake gh: unsupported " + args.join(" ")); save(); process.exit(2);
`;

const FAKE_CLAUDE = `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$FAKE_GH_DIR/claude-args"
if [ "\${FAKE_CLAUDE_MODE:-}" = blocked ]; then
  printf '{"status":"blocked","reason":"needs a product call","question":"Keep the old API?"}' > "$FACTORY_SIGNAL_FILE"
else
  echo "agent change" > AGENT.md
fi
`;

export interface FakePr {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly head: string;
  readonly base: string;
  readonly body: string;
  readonly state: string;
  readonly autoMerge: boolean;
}

export interface GitFixture {
  readonly root: string;
  readonly origin: string;
  readonly env: NodeJS.ProcessEnv;
  readonly repo: string;
  bash(script: string): Promise<CommandResult>;
  git(...args: string[]): Promise<string>;
  gh(): Promise<{ readonly prs: readonly FakePr[]; readonly calls: readonly (readonly string[])[] }>;
}

export async function gitFixture(repo = "owner/sandbox"): Promise<GitFixture> {
  const root = await mkdtemp(join(tmpdir(), "factory-fixture-"));
  const bin = join(root, "bin");
  const ghDir = join(root, "gh");
  const origin = join(root, "origin.git");
  await mkdir(bin);
  await mkdir(ghDir);
  await writeFile(join(bin, "gh"), FAKE_GH.replace("#!/usr/bin/env node", `#!${process.execPath}`));
  await chmod(join(bin, "gh"), 0o755);
  await writeFile(join(bin, "claude"), FAKE_CLAUDE);
  await chmod(join(bin, "claude"), 0o755);

  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:${process.env["PATH"] ?? ""}`,
    HOME: root,
    FAKE_GH_DIR: ghDir,
    GH_TOKEN: "fake-token",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(root, "fixture.gitconfig"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.${origin}.insteadOf`,
    GIT_CONFIG_VALUE_0: `https://github.com/${repo}.git`,
  };

  const bash = (script: string) => runCommand(["bash", "-c", script], { cwd: root, env });
  const git = async (...args: string[]) => {
    const result = await runCommand(["git", ...args], { cwd: root, env });
    if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };

  await git("init", "--quiet", "--bare", "--initial-branch=main", origin);
  const seed = join(root, "seed");
  await git("init", "--quiet", "--initial-branch=main", seed);
  await writeFile(join(seed, "README.md"), "# sandbox\n");
  await git("-C", seed, "add", "README.md");
  await git("-C", seed, "-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "commit", "--quiet", "-m", "seed");
  await git("-C", seed, "push", "--quiet", origin, "main");

  return {
    root,
    origin,
    env,
    repo,
    bash,
    git,
    async gh() {
      try {
        return JSON.parse(await readFile(join(ghDir, "state.json"), "utf8"));
      } catch {
        return { prs: [], calls: [] };
      }
    },
  };
}
