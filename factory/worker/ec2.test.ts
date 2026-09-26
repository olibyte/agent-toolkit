import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runCommand, type CommandRunner } from "../exec.ts";
import {
  AwsCliError,
  awsCli,
  configuredRegion,
  ec2WorkerProvider,
  imageFor,
  loadEc2Config,
  type AwsCli,
  type Ec2WorkerConfig,
} from "./ec2.ts";
import type { WorkerRef } from "./types.ts";

type Reply = unknown | Error;

function fakeAws(script: Record<string, Reply[]>) {
  const calls: { args: readonly string[]; region: string }[] = [];
  const aws: AwsCli = async (args, region) => {
    calls.push({ args, region });
    const key = args.slice(0, 2).join(" ");
    const queue = script[key];
    if (queue === undefined || queue.length === 0) throw new Error(`unexpected aws ${key}`);
    const reply = queue.length === 1 ? queue[0] : queue.shift();
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { aws, calls, deps: { aws, sleep: async () => {}, pollMs: 1 } };
}

const config: Ec2WorkerConfig = {
  region: "us-east-1",
  instanceProfile: "factory-worker-profile",
  securityGroupId: "sg-123",
  subnetId: null,
  instanceType: "t3.small",
  volumeGb: 20,
  imageId: imageFor("t3.small"),
  parameterPrefix: "/agent-factory",
  maxLifetimeMinutes: 90,
};

const ref: WorkerRef = { kind: "ec2", instanceId: "i-abc", region: "us-east-1", instanceType: "t3.small" };

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

describe("ec2 worker provider", () => {
  it("launches a tagged, SSM-only, self-terminating instance", async () => {
    const fake = fakeAws({ "ec2 run-instances": [{ Instances: [{ InstanceId: "i-abc" }] }] });
    const launched = await ec2WorkerProvider(config, fake.deps).launch("run-1");
    assert.deepEqual(launched, ref);

    const args = fake.calls[0]?.args ?? [];
    assert.equal(fake.calls[0]?.region, "us-east-1");
    assert.equal(flag(args, "--iam-instance-profile"), "Name=factory-worker-profile");
    assert.equal(flag(args, "--security-group-ids"), "sg-123");
    assert.equal(flag(args, "--instance-initiated-shutdown-behavior"), "terminate");
    assert.equal(flag(args, "--metadata-options"), "HttpTokens=required,HttpEndpoint=enabled");
    assert.match(flag(args, "--user-data") ?? "", /shutdown -h \+90/);
    assert.match(flag(args, "--image-id") ?? "", /al2023-ami-kernel-default-x86_64$/);
    assert.deepEqual(JSON.parse(flag(args, "--block-device-mappings") ?? "[]"), [
      { DeviceName: "/dev/xvda", Ebs: { VolumeSize: 20, VolumeType: "gp3", Encrypted: true, DeleteOnTermination: true } },
    ]);
    assert.equal(args.includes("--key-name"), false);
    assert.equal(args.includes("--subnet-id"), false);
    const tags = JSON.parse(flag(args, "--tag-specifications") ?? "[]");
    assert.deepEqual(tags[0].Tags[1], { Key: "agent-factory:run", Value: "run-1" });
  });

  it("waits until the SSM agent is online", async () => {
    const fake = fakeAws({
      "ssm describe-instance-information": [
        { InstanceInformationList: [] },
        { InstanceInformationList: [{ PingStatus: "ConnectionLost" }] },
        { InstanceInformationList: [{ PingStatus: "Online" }] },
      ],
    });
    await ec2WorkerProvider(config, fake.deps).ready(ref);
    assert.equal(fake.calls.length, 3);
  });

  it("gives up on SSM registration after the deadline", async () => {
    let clock = 0;
    const fake = fakeAws({ "ssm describe-instance-information": [{ InstanceInformationList: [] }] });
    const provider = ec2WorkerProvider(config, { ...fake.deps, now: () => (clock += 120_000) });
    await assert.rejects(provider.ready(ref), /timed out waiting for SSM registration of i-abc/);
  });

  it("ships the phase script over SSM and returns its exit code and output", async () => {
    const fake = fakeAws({
      "ssm send-command": [{ Command: { CommandId: "cmd-1" } }],
      "ssm get-command-invocation": [
        new AwsCliError("ssm get-command-invocation", "An error occurred (InvocationDoesNotExist) when calling"),
        { Status: "InProgress" },
        { Status: "Failed", ResponseCode: 3, StandardOutputContent: "lint: 3 errors\n", StandardErrorContent: "" },
      ],
    });
    const script = "#!/usr/bin/env bash\necho \"it's $HOME\"\n";
    const result = await ec2WorkerProvider(config, fake.deps).exec(ref, "verify", script, 1800);
    assert.deepEqual(result, { exitCode: 3, output: "lint: 3 errors\n" });

    const send = fake.calls[0]?.args ?? [];
    assert.equal(flag(send, "--document-name"), "AWS-RunShellScript");
    assert.equal(flag(send, "--instance-ids"), "i-abc");
    const parameters = JSON.parse(flag(send, "--parameters") ?? "{}");
    assert.deepEqual(parameters.executionTimeout, ["1800"]);
    assert.equal(parameters.commands[0], 'script="$(mktemp)"');
    const encoded = /^echo (\S+) \| base64 -d > "\$script"$/.exec(parameters.commands[1])?.[1];
    assert.equal(Buffer.from(encoded ?? "", "base64").toString(), script);
    assert.equal(parameters.commands[2], 'bash "$script"');
  });

  it("maps an SSM timeout to exit 124 with the status detail", async () => {
    const fake = fakeAws({
      "ssm send-command": [{ Command: { CommandId: "cmd-1" } }],
      "ssm get-command-invocation": [
        { Status: "TimedOut", StatusDetails: "ExecutionTimedOut", ResponseCode: -1, StandardOutputContent: "" },
      ],
    });
    const result = await ec2WorkerProvider(config, fake.deps).exec(ref, "change", "true", 60);
    assert.equal(result.exitCode, 124);
    assert.match(result.output, /SSM command TimedOut: ExecutionTimedOut/);
  });

  it("terminates and waits for the terminated state", async () => {
    const fake = fakeAws({
      "ec2 terminate-instances": [{}],
      "ec2 describe-instances": [
        { Reservations: [{ Instances: [{ State: { Name: "shutting-down" } }] }] },
        { Reservations: [{ Instances: [{ State: { Name: "terminated" } }] }] },
      ],
    });
    await ec2WorkerProvider(config, fake.deps).terminate(ref);
    assert.deepEqual(
      fake.calls.map((call) => call.args[1]),
      ["terminate-instances", "describe-instances", "describe-instances"]
    );
  });

  it("treats an already-gone instance as terminated", async () => {
    const fake = fakeAws({
      "ec2 terminate-instances": [
        new AwsCliError("ec2 terminate-instances", "An error occurred (InvalidInstanceID.NotFound) when calling"),
      ],
    });
    await ec2WorkerProvider(config, fake.deps).terminate(ref);
    assert.equal(fake.calls.length, 1);
  });

  it("renders a worker environment that is valid bash and holds no secret values", async () => {
    const environment = ec2WorkerProvider(config, fakeAws({}).deps).environment(ref);
    const parts = [
      environment.preamble,
      environment.githubAuth,
      environment.setup,
      environment.installPackages(["python3.12", "gcc-c++"]),
      environment.agentSetup("claude-code"),
      environment.agentSetup("codex"),
    ];
    for (const part of parts) {
      const syntax = await runCommand(["bash", "-n"], { input: part });
      assert.equal(syntax.code, 0, syntax.stderr);
    }
    assert.match(environment.preamble, /aws ssm get-parameter --name '\/agent-factory\/'"\$1" --with-decryption/);
    assert.match(environment.preamble, /export HOME=\/root/);
    assert.doesNotMatch(environment.preamble, /GH_TOKEN/);
    assert.match(environment.githubAuth, /GH_TOKEN="\$\(factory_secret github-token\)"/);
    assert.match(environment.setup, /gh_2\.97\.0_linux_/);
    assert.match(environment.agentSetup("codex"), /@openai\/codex/);
    assert.match(environment.agentSetup("codex"), /factory_task 'npx --yes skills@latest add/);
    assert.match(environment.setup, /useradd --create-home --shell \/bin\/bash factory-task/);
    assert.match(environment.setup, /meta skuid \$task_uid ip daddr 169\.254\.169\.254 reject/);
    assert.match(environment.setup, /if factory_task 'curl -s -m 5 -o \/dev\/null http:\/\/169\.254\.169\.254\/'; then .* exit 1; fi/);
    assert.equal(environment.installPackages(["python3.12", "gcc-c++"]), "dnf install -y -q 'python3.12' 'gcc-c++'");
  });

  it("runs task commands with a clean environment that carries only the named variables", async () => {
    const environment = ec2WorkerProvider(config, fakeAws({}).deps).environment(ref);
    const script = [
      environment.preamble,
      'setpriv() { while [ "$1" != -- ]; do shift; done; shift; "$@"; }',
      "cd() { builtin cd /; }",
      "export GH_TOKEN=secret ANTHROPIC_API_KEY=key AWS_PROFILE=admin",
      `factory_task 'echo "\${GH_TOKEN:-none} \${ANTHROPIC_API_KEY:-none} \${AWS_PROFILE:-none} $USER $HOME $PATH"' ANTHROPIC_API_KEY`,
      `factory_task 'echo "\${ANTHROPIC_API_KEY:-none} $GIT_CONFIG_GLOBAL"'`,
    ].join("\n");
    const result = await runCommand(["bash", "-c", script]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split("\n"), [
      "none key none factory-task /home/factory-task /home/factory-task/.local/bin:/usr/local/bin:/usr/bin:/bin",
      "none /opt/agent-factory/gitconfig",
    ]);
  });
});

describe("ec2 config", () => {
  it("finds the Terraform-managed worker resources by name", async () => {
    const fake = fakeAws({ "ec2 describe-security-groups": [{ SecurityGroups: [{ GroupId: "sg-9" }] }] });
    const loaded = await loadEc2Config(fake.aws, { region: "eu-west-2", name: "agent-factory", instanceType: "t4g.small", volumeGb: 30 });
    assert.equal(loaded.instanceProfile, "agent-factory-worker");
    assert.equal(loaded.securityGroupId, "sg-9");
    assert.equal(loaded.volumeGb, 30);
    assert.equal(loaded.parameterPrefix, "/agent-factory");
    assert.equal(loaded.subnetId, null);
    assert.match(loaded.imageId, /arm64$/);
    assert.deepEqual(fake.calls[0], {
      args: ["ec2", "describe-security-groups", "--filters", "Name=group-name,Values=agent-factory-worker"],
      region: "eu-west-2",
    });
  });

  it("points at terraform when the infrastructure is missing, and refuses ambiguity", async () => {
    const missing = fakeAws({ "ec2 describe-security-groups": [{ SecurityGroups: [] }] });
    await assert.rejects(
      loadEc2Config(missing.aws, { region: "r", name: "agent-factory", instanceType: "t3.small", volumeGb: 20 }),
      /no security group named agent-factory-worker in r\. Run terraform apply in factory\/infra first/
    );
    const twice = fakeAws({ "ec2 describe-security-groups": [{ SecurityGroups: [{ GroupId: "a" }, { GroupId: "b" }] }] });
    await assert.rejects(
      loadEc2Config(twice.aws, { region: "r", name: "agent-factory", instanceType: "t3.small", volumeGb: 20 }),
      /2 security groups/
    );
  });

  it("picks the image architecture from the instance family", () => {
    assert.match(imageFor("t3.small"), /x86_64$/);
    assert.match(imageFor("m7i.large"), /x86_64$/);
    assert.match(imageFor("t4g.small"), /arm64$/);
    assert.match(imageFor("c7gn.large"), /arm64$/);
  });
});

describe("aws cli runner", () => {
  it("scopes a factory profile to its own aws calls", async () => {
    const envs: (NodeJS.ProcessEnv | undefined)[] = [];
    const runner: CommandRunner = async (argv, options) => {
      envs.push(options?.env);
      return { code: 0, stdout: argv.includes("configure") ? "eu-west-2\n" : "{}", stderr: "", timedOut: false };
    };
    await awsCli(runner, "agent-factory")(["sts", "get-caller-identity"], "eu-west-2");
    assert.equal(await configuredRegion(runner, "agent-factory"), "eu-west-2");
    assert.deepEqual(envs.map((env) => env?.["AWS_PROFILE"]), ["agent-factory", "agent-factory"]);
    await awsCli(runner)(["sts", "get-caller-identity"], "eu-west-2");
    assert.equal(envs[2]?.["AWS_PROFILE"], process.env["AWS_PROFILE"]);
  });

  it("reports no configured region instead of failing", async () => {
    const unset: CommandRunner = async () => ({ code: 1, stdout: "", stderr: "", timedOut: false });
    assert.equal(await configuredRegion(unset), null);
  });

  it("adds region and JSON output, and surfaces the AWS error code", async () => {
    const seen: (readonly string[])[] = [];
    const cli = awsCli(async (argv) => {
      seen.push(argv);
      return argv.includes("fail")
        ? { code: 254, stdout: "", stderr: "\nAn error occurred (UnauthorizedOperation) when calling X", timedOut: false }
        : { code: 0, stdout: '{"ok":true}', stderr: "", timedOut: false };
    });
    assert.deepEqual(await cli(["sts", "get-caller-identity"], "us-east-1"), { ok: true });
    assert.deepEqual(seen[0], ["aws", "sts", "get-caller-identity", "--region", "us-east-1", "--output", "json"]);
    await assert.rejects(cli(["ec2", "fail"], "us-east-1"), (error: AwsCliError) => error.code === "UnauthorizedOperation");
  });
});
