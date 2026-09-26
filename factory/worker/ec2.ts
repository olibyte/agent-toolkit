import { firstLine, runCommand, type CommandRunner } from "../exec.ts";
import { shq } from "../shell.ts";
import type { AgentHarness } from "../task.ts";
import type { PhaseResult, WorkerProvider, WorkerRef } from "./types.ts";

export const GH_VERSION = "2.97.0";
export const NODE_VERSION = "24.18.0";
export const WORKDIR = "/opt/agent-factory";

const AGENT_PACKAGE: Readonly<Record<AgentHarness, { bin: string; pkg: string; skillsAgent: string }>> = {
  "claude-code": { bin: "claude", pkg: "@anthropic-ai/claude-code", skillsAgent: "claude-code" },
  codex: { bin: "codex", pkg: "@openai/codex", skillsAgent: "codex" },
};

const PENDING_COMMAND_STATUSES = new Set(["Pending", "InProgress", "Delayed", "Cancelling"]);

export type AwsCli = (args: readonly string[], region: string) => Promise<unknown>;

export class AwsCliError extends Error {
  override name = "AwsCliError";
  readonly code: string | null;

  constructor(command: string, stderr: string) {
    super(`aws ${command}: ${firstLine(stderr)}`);
    this.code = /\(([A-Za-z.]+)\)/.exec(stderr)?.[1] ?? null;
  }
}

function awsEnv(profile: string | null): NodeJS.ProcessEnv {
  return { ...process.env, AWS_PAGER: "", ...(profile === null ? {} : { AWS_PROFILE: profile }) };
}

async function runAws(runner: CommandRunner, argv: readonly string[], profile: string | null) {
  try {
    return await runner(["aws", ...argv], { env: awsEnv(profile) });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("aws CLI not found on PATH");
    throw error;
  }
}

export function awsCli(runner: CommandRunner = runCommand, profile: string | null = null): AwsCli {
  return async (args, region) => {
    const result = await runAws(runner, [...args, "--region", region, "--output", "json"], profile);
    if (result.code !== 0) throw new AwsCliError(args.slice(0, 2).join(" "), result.stderr);
    return result.stdout.trim() === "" ? null : JSON.parse(result.stdout);
  };
}

export async function configuredRegion(runner: CommandRunner = runCommand, profile: string | null = null): Promise<string | null> {
  const result = await runAws(runner, ["configure", "get", "region"], profile);
  const region = result.stdout.trim();
  return result.code === 0 && region !== "" ? region : null;
}

export interface Ec2WorkerConfig {
  readonly region: string;
  readonly instanceProfile: string;
  readonly securityGroupId: string;
  readonly subnetId: string | null;
  readonly instanceType: string;
  readonly imageId: string;
  readonly parameterPrefix: string;
  readonly maxLifetimeMinutes: number;
}

export interface Ec2Deps {
  readonly aws: AwsCli;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly pollMs?: number;
}

function pick(value: unknown, path: readonly (string | number)[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

function pickString(value: unknown, path: readonly (string | number)[], label: string): string {
  const found = pick(value, path);
  if (typeof found !== "string" || found === "") throw new Error(`${label}: missing ${path.join(".")}`);
  return found;
}

export function imageFor(instanceType: string): string {
  const arch = /^[a-z]+\d+[a-z]*g[a-z]*\./.test(instanceType) ? "arm64" : "x86_64";
  return `resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-${arch}`;
}

export function infraNames(name: string) {
  return { worker: `${name}-worker`, parameterPrefix: `/${name}` } as const;
}

export async function loadEc2Config(
  aws: AwsCli,
  options: { readonly region: string; readonly name: string; readonly instanceType: string }
): Promise<Ec2WorkerConfig> {
  const names = infraNames(options.name);
  const described = await aws(
    ["ec2", "describe-security-groups", "--filters", `Name=group-name,Values=${names.worker}`],
    options.region
  );
  const groups = pick(described, ["SecurityGroups"]);
  const count = Array.isArray(groups) ? groups.length : 0;
  if (count !== 1) {
    throw new Error(
      count === 0
        ? `no security group named ${names.worker} in ${options.region}. Run terraform apply in factory/infra first.`
        : `${count} security groups are named ${names.worker} in ${options.region}; expected one`
    );
  }
  return {
    region: options.region,
    instanceProfile: names.worker,
    securityGroupId: pickString(described, ["SecurityGroups", 0, "GroupId"], "describe-security-groups"),
    subnetId: null,
    instanceType: options.instanceType,
    imageId: imageFor(options.instanceType),
    parameterPrefix: names.parameterPrefix,
    maxLifetimeMinutes: 90,
  };
}

export function userData(maxLifetimeMinutes: number): string {
  return `#!/bin/bash\nshutdown -h +${maxLifetimeMinutes} "agent-factory lifetime limit"\n`;
}

function ec2Ref(ref: WorkerRef): Extract<WorkerRef, { kind: "ec2" }> {
  if (ref.kind !== "ec2") throw new Error(`ec2 worker cannot drive a ${ref.kind} worker`);
  return ref;
}

export async function terminateInstance(deps: Ec2Deps, ref: WorkerRef): Promise<void> {
  const { instanceId, region } = ec2Ref(ref);
  try {
    await deps.aws(["ec2", "terminate-instances", "--instance-ids", instanceId], region);
  } catch (error) {
    if (error instanceof AwsCliError && error.code === "InvalidInstanceID.NotFound") return;
    throw error;
  }
  await poll(deps, `termination of ${instanceId}`, 600_000, async () => {
    const described = await deps.aws(["ec2", "describe-instances", "--instance-ids", instanceId], region);
    return pick(described, ["Reservations", 0, "Instances", 0, "State", "Name"]) === "terminated" || false;
  });
}

async function poll<T>(
  deps: Ec2Deps,
  label: string,
  timeoutMs: number,
  check: () => Promise<T | false>
): Promise<T> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== false) return value;
    if (now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(deps.pollMs ?? 5000);
  }
}

export function ec2WorkerProvider(config: Ec2WorkerConfig, deps: Ec2Deps): WorkerProvider {
  const { aws } = deps;
  const { region } = config;

  return {
    async launch(runId) {
      const tags = [
        { Key: "Name", Value: `agent-factory-${runId}` },
        { Key: "agent-factory:run", Value: runId },
      ];
      const launched = await aws(
        [
          "ec2",
          "run-instances",
          "--image-id",
          config.imageId,
          "--instance-type",
          config.instanceType,
          "--count",
          "1",
          "--iam-instance-profile",
          `Name=${config.instanceProfile}`,
          "--security-group-ids",
          config.securityGroupId,
          ...(config.subnetId === null ? [] : ["--subnet-id", config.subnetId]),
          "--instance-initiated-shutdown-behavior",
          "terminate",
          "--metadata-options",
          "HttpTokens=required,HttpEndpoint=enabled",
          "--user-data",
          userData(config.maxLifetimeMinutes),
          "--tag-specifications",
          JSON.stringify([
            { ResourceType: "instance", Tags: tags },
            { ResourceType: "volume", Tags: tags },
          ]),
        ],
        region
      );
      return {
        kind: "ec2",
        instanceId: pickString(launched, ["Instances", 0, "InstanceId"], "run-instances"),
        region,
        instanceType: config.instanceType,
      };
    },

    async ready(ref) {
      const { instanceId } = ec2Ref(ref);
      await poll(deps, `SSM registration of ${instanceId}`, 600_000, async () => {
        const info = await aws(
          ["ssm", "describe-instance-information", "--filters", `Key=InstanceIds,Values=${instanceId}`],
          region
        );
        return pick(info, ["InstanceInformationList", 0, "PingStatus"]) === "Online" || false;
      });
    },

    environment() {
      const secret = (name: string) => `${config.parameterPrefix}/${name}`;
      return {
        workdir: WORKDIR,
        preamble: [
          "export HOME=/root",
          'export PATH="/usr/local/bin:$PATH"',
          `export AWS_REGION=${shq(region)} AWS_DEFAULT_REGION=${shq(region)}`,
          `export GIT_CONFIG_GLOBAL=${shq(`${WORKDIR}/gitconfig`)}`,
          `factory_secret() { aws ssm get-parameter --name ${shq(`${config.parameterPrefix}/`)}"$1" --with-decryption --query Parameter.Value --output text 2>/dev/null; }`,
        ].join("\n"),
        githubAuth: [
          `GH_TOKEN="$(factory_secret github-token)" || { echo ${shq(`cannot read SSM parameter ${secret("github-token")}`)} >&2; exit 1; }`,
          "export GH_TOKEN",
        ].join("\n"),
        setup: [
          "cloud-init status --wait >/dev/null 2>&1 || true",
          "command -v git >/dev/null || dnf install -y -q git",
          "if ! command -v gh >/dev/null; then",
          '  case "$(uname -m)" in x86_64) gh_arch=amd64 ;; aarch64) gh_arch=arm64 ;; *) echo "unsupported arch" >&2; exit 1 ;; esac',
          `  curl -fsSL -o /tmp/gh.tar.gz "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_\${gh_arch}.tar.gz"`,
          "  tar -xzf /tmp/gh.tar.gz -C /tmp",
          `  install -m 0755 "/tmp/gh_${GH_VERSION}_linux_\${gh_arch}/bin/gh" /usr/local/bin/gh`,
          "fi",
          "git --version",
          "gh --version | head -n 1",
        ].join("\n"),
        agentSetup(harness) {
          const agent = AGENT_PACKAGE[harness];
          return [
            "if ! command -v node >/dev/null; then",
            '  case "$(uname -m)" in x86_64) node_arch=x64 ;; aarch64) node_arch=arm64 ;; *) echo "unsupported arch" >&2; exit 1 ;; esac',
            `  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-\${node_arch}.tar.xz" | tar -xJ -C /usr/local --strip-components=1`,
            "fi",
            `command -v ${agent.bin} >/dev/null || npm install -g --silent ${agent.pkg}`,
            `npx --yes skills@latest add olibyte/agent-toolkit -g -a ${agent.skillsAgent} -y > /dev/null`,
          ].join("\n");
        },
      };
    },

    async exec(ref, phase, script, timeoutSeconds): Promise<PhaseResult> {
      const { instanceId } = ec2Ref(ref);
      const file = `/tmp/agent-factory-${phase}.sh`;
      const parameters = {
        commands: [`echo ${Buffer.from(script).toString("base64")} | base64 -d > ${file}`, `bash ${file}`],
        executionTimeout: [String(timeoutSeconds)],
      };
      const sent = await aws(
        [
          "ssm",
          "send-command",
          "--instance-ids",
          instanceId,
          "--document-name",
          "AWS-RunShellScript",
          "--comment",
          `agent-factory ${phase}`,
          "--timeout-seconds",
          "120",
          "--parameters",
          JSON.stringify(parameters),
        ],
        region
      );
      const commandId = pickString(sent, ["Command", "CommandId"], "send-command");
      const invocation = await poll(deps, `${phase} on ${instanceId}`, (timeoutSeconds + 300) * 1000, async () => {
        let current: unknown;
        try {
          current = await aws(
            ["ssm", "get-command-invocation", "--command-id", commandId, "--instance-id", instanceId],
            region
          );
        } catch (error) {
          if (error instanceof AwsCliError && error.code === "InvocationDoesNotExist") return false;
          throw error;
        }
        return PENDING_COMMAND_STATUSES.has(String(pick(current, ["Status"]))) ? false : current;
      });
      const status = String(pick(invocation, ["Status"]));
      const code = pick(invocation, ["ResponseCode"]);
      const stdout = String(pick(invocation, ["StandardOutputContent"]) ?? "");
      const stderr = String(pick(invocation, ["StandardErrorContent"]) ?? "");
      const note =
        status === "Success" || status === "Failed"
          ? ""
          : `\nSSM command ${status}: ${String(pick(invocation, ["StatusDetails"]) ?? "")}`;
      return {
        exitCode: status === "TimedOut" ? 124 : typeof code === "number" && code >= 0 ? code : 1,
        output: `${stdout}${stderr}${note}`,
      };
    },

    terminate: (ref) => terminateInstance(deps, ref),
  };
}
