export const PR_STATES = ["OPEN", "CLOSED", "MERGED"] as const;
export type PrState = (typeof PR_STATES)[number];

export interface PullRequest {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly state: PrState;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly isDraft: boolean;
  readonly autoMerge: boolean;
}

export const PR_VIEW_FIELDS =
  "number,url,title,state,headRefName,baseRefName,isDraft,autoMergeRequest";

export class PullRequestParseError extends Error {
  override name = "PullRequestParseError";
}

function invalid(key: string, value: unknown, expected: string): never {
  throw new PullRequestParseError(`gh pr view: ${key} is ${JSON.stringify(value)}, expected ${expected}`);
}

function str(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : invalid(key, value, "string");
}

function num(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === "number" ? value : invalid(key, value, "number");
}

function bool(source: Record<string, unknown>, key: string): boolean {
  const value = source[key];
  return typeof value === "boolean" ? value : invalid(key, value, "boolean");
}

export function parsePullRequest(value: unknown): PullRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PullRequestParseError("gh pr view did not return a JSON object");
  }
  const source = value as Record<string, unknown>;
  const state = str(source, "state");
  const prState = PR_STATES.find((candidate) => candidate === state) ?? invalid("state", state, PR_STATES.join("|"));
  return {
    number: num(source, "number"),
    url: str(source, "url"),
    title: str(source, "title"),
    state: prState,
    headRefName: str(source, "headRefName"),
    baseRefName: str(source, "baseRefName"),
    isDraft: bool(source, "isDraft"),
    autoMerge: source["autoMergeRequest"] !== null && source["autoMergeRequest"] !== undefined,
  };
}
