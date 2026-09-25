import { shq } from "../shell.ts";
import { PR_VIEW_FIELDS } from "./pr.ts";

export const FACTORY_AUTHOR = {
  name: "agent-factory",
  email: "agent-factory@users.noreply.github.com",
} as const;

export interface CheckoutOptions {
  readonly repo: string;
  readonly base: string;
  readonly branch: string;
  readonly repoDir: string;
}

export interface PublishOptions {
  readonly repo: string;
  readonly base: string;
  readonly branch: string;
  readonly repoDir: string;
  readonly title: string;
  readonly commitTrailer: string;
  readonly body: string;
  readonly bodyFile: string;
  readonly resultFile: string;
  readonly autoMerge: boolean;
}

export function taskBranch(prefix: string, runId: string): string {
  return `${prefix}${runId}`;
}

export function checkoutScript(options: CheckoutOptions): string {
  const dir = shq(options.repoDir);
  return [
    "gh auth setup-git",
    `git config --global user.name ${shq(FACTORY_AUTHOR.name)}`,
    `git config --global user.email ${shq(FACTORY_AUTHOR.email)}`,
    `rm -rf ${dir}`,
    `git clone --quiet --branch ${shq(options.base)} ${shq(`https://github.com/${options.repo}.git`)} ${dir}`,
    `git -C ${dir} switch --quiet --create ${shq(options.branch)}`,
    `git -C ${dir} log -1 --oneline`,
  ].join("\n");
}

export function publishScript(options: PublishOptions): string {
  const repo = shq(options.repo);
  const branch = shq(options.branch);
  const lines = [
    `cd ${shq(options.repoDir)}`,
    "git add --all",
    `git diff --cached --quiet || git commit --quiet -m ${shq(options.title)} -m ${shq(options.commitTrailer)}`,
    `if [ "$(git rev-list --count ${shq(`origin/${options.base}`)}..HEAD)" = 0 ]; then`,
    `  echo ${shq(`nothing to publish: ${options.branch} has no commits beyond ${options.base}`)} >&2`,
    "  exit 1",
    "fi",
    `git push --quiet --set-upstream origin ${shq(`HEAD:refs/heads/${options.branch}`)}`,
    `pr_url="$(gh pr list --repo ${repo} --head ${branch} --state open --json url --jq '.[0].url // empty')"`,
    'if [ -z "$pr_url" ]; then',
    `  printf '%s\\n' ${shq(options.body)} > ${shq(options.bodyFile)}`,
    `  pr_url="$(gh pr create --repo ${repo} --base ${shq(options.base)} --head ${branch} --title ${shq(options.title)} --body-file ${shq(options.bodyFile)} | tail -n 1)"`,
    "fi",
    'echo "pull request: $pr_url"',
  ];
  if (options.autoMerge) {
    lines.push(
      `gh pr merge "$pr_url" --repo ${repo} --auto --squash || echo "warning: could not enable auto-merge for $pr_url" >&2`
    );
  }
  lines.push(`gh pr view "$pr_url" --repo ${repo} --json ${PR_VIEW_FIELDS} > ${shq(options.resultFile)}`);
  return lines.join("\n");
}
