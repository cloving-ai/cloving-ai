import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { DoctorObservation } from "../doctor-report.ts";
import type { TurnProfile } from "../turn-profile.ts";
import type { ProbeOutput, ProbeRunner } from "./probe-command.ts";
import type { ProfileRunners } from "./doctor-runners.ts";
import { runnerSetup } from "./runner-setup.ts";
import {
  commitSignaturesSetting,
  passedVariables,
  turnVariablesSetting,
  withheldVariables,
  type CommitSignatures,
  type TurnVariables,
} from "../turn-environment.ts";

function configuredVariables(
  environment: Readonly<NodeJS.ProcessEnv>,
): TurnVariables | undefined {
  try {
    return turnVariablesSetting(environment["CLOVING_TURN_ENVIRONMENT"]);
  } catch {
    return undefined;
  }
}

export function turnEnvironmentObservation(
  environment: Readonly<NodeJS.ProcessEnv>,
): DoctorObservation {
  const variables = configuredVariables(environment);
  if (variables === undefined)
    return {
      result: "fail",
      detail: "invalid-setting: CLOVING_TURN_ENVIRONMENT",
    };
  if (variables === "inherit")
    return {
      result: "warn",
      detail:
        "turns.environment is inherit: a turn gets all variables of the service environment except the GitHub tokens",
    };
  const withheld = withheldVariables(environment, {
    worker: environment["CLOVING_WORKER"] ?? "claude",
    variables,
  });
  const count = `${String(withheld.length)} ${withheld.length === 1 ? "variable" : "variables"}`;
  return {
    result: "ok",
    detail:
      withheld.length === 0
        ? "A turn gets all variables of the service environment except the GitHub tokens"
        : `A turn does not get ${count} of the service environment: ${withheld.join(", ")}`,
  };
}

const signatureMilliseconds = 10_000;

function configuredSignatures(
  environment: Readonly<NodeJS.ProcessEnv>,
): CommitSignatures | undefined {
  try {
    return commitSignaturesSetting(
      environment["CLOVING_TURN_COMMIT_SIGNATURES"],
    );
  } catch {
    return undefined;
  }
}

function signatureError(output: ProbeOutput): string {
  if (output.reason === "probe-timeout")
    return `the signature did not end in ${String(signatureMilliseconds / 1000)} seconds`;
  const line = (output.stderr ?? "")
    .split("\n")
    .map((text) => text.trim())
    .find((text) => text !== "");
  return line ?? String(output.reason);
}

interface SignatureContext {
  readonly repository: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly probe: ProbeRunner;
  readonly variables: TurnVariables;
}

interface SignatureTarget {
  readonly label: string;
  readonly profile: TurnProfile;
}

interface TargetResult {
  readonly state: "off" | "ok" | "fail";
  readonly detail: string;
}

async function targetGit(
  context: SignatureContext & { readonly profile: TurnProfile },
  parts: readonly string[],
): Promise<ProbeOutput> {
  const { environment, probe, profile } = context;
  const setup = runnerSetup(
    {
      ...(profile.runner === undefined ? {} : { runner: profile.runner }),
      directory: context.repository,
      folder: tmpdir(),
      turnId: "doctor-signature",
    },
    {
      command: ["git", ...parts],
      environment: {
        ...passedVariables(environment, {
          worker: profile.harness ?? environment["CLOVING_WORKER"] ?? "claude",
          variables: context.variables,
        }),
        ...profile.env,
      },
      serviceEnvironment: environment,
    },
  );
  const [executable = "git", ...rest] = setup.command;
  const output = await probe(executable, {
    arguments: rest,
    env: setup.environment,
    directory: context.repository,
    milliseconds: signatureMilliseconds,
  });
  if (setup.kind === "host") return output;
  rmSync(setup.folder, { recursive: true, force: true });
  if (output.reason === "probe-timeout" && setup.runner.kind === "container")
    await probe(setup.runner.engine, {
      arguments: ["rm", "-f", setup.name],
      env: setup.environment,
      milliseconds: 30_000,
    });
  return output;
}

async function targetSignature(
  context: SignatureContext,
  target: SignatureTarget,
): Promise<TargetResult> {
  const git = (parts: readonly string[]) =>
    targetGit({ ...context, profile: target.profile }, parts);
  const result = (state: TargetResult["state"], detail: string) => ({
    state,
    detail: `${target.label}${detail}`,
  });
  const signing = await git([
    "config",
    "--type=bool",
    "--get",
    "commit.gpgsign",
  ]);
  if (signing.reason !== null && signing.exitCode !== 1)
    return result(
      "fail",
      `A turn cannot read commit.gpgsign: ${signatureError(signing)}`,
    );
  if (signing.stdout.trim() !== "true")
    return result("off", "Commit signatures are off");
  const configured = await git(["config", "--get", "gpg.format"]);
  const format = configured.stdout.trim() || "openpgp";
  const tree = await git(["hash-object", "-t", "tree", "/dev/null"]);
  const signed = await git([
    "commit-tree",
    "-S",
    "-m",
    "cloving doctor test signature",
    tree.stdout.trim(),
  ]);
  return signed.reason === null
    ? result("ok", `A turn can sign commits (gpg.format ${format})`)
    : result(
        "fail",
        `A turn cannot sign commits (gpg.format ${format}): ${signatureError(signed)}`,
      );
}

function signatureTargets(runners: ProfileRunners): SignatureTarget[] {
  const stopped = new Set(runners.problems.map((item) => item.name));
  return Object.entries(runners.profiles).flatMap(([name, profile]) => {
    const boxed =
      profile.runner !== undefined && profile.runner.kind !== "host";
    const own = boxed || profile.env !== undefined;
    return own && !stopped.has(name)
      ? [{ label: `profile ${name}: `, profile }]
      : [];
  });
}

async function testSignatures(
  context: SignatureContext,
  runners: ProfileRunners,
): Promise<DoctorObservation> {
  const results = [await targetSignature(context, { label: "", profile: {} })];
  for (const target of signatureTargets(runners))
    results.push(await targetSignature(context, target));
  const joined = (items: readonly TargetResult[]) =>
    items.map((item) => item.detail).join("; ");
  const failed = results.filter((item) => item.state === "fail");
  if (failed.length > 0) return { result: "fail", detail: joined(failed) };
  if (results.every((item) => item.state === "off"))
    return { result: "ok", detail: "Commit signatures are off" };
  return { result: "ok", detail: joined(results) };
}

export async function commitSignatureObservation(context: {
  readonly repository: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly probe: ProbeRunner;
  readonly runners: ProfileRunners | undefined;
}): Promise<DoctorObservation> {
  const { environment } = context;
  const signatures = configuredSignatures(environment);
  if (signatures === undefined)
    return {
      result: "fail",
      detail: "invalid-setting: CLOVING_TURN_COMMIT_SIGNATURES",
    };
  if (signatures === "off")
    return {
      result: "ok",
      detail: "Turns commit with no signature (turns.commitSignatures off)",
    };
  const variables = configuredVariables(environment);
  if (variables === undefined)
    return {
      result: "skip",
      detail: "invalid-setting: CLOVING_TURN_ENVIRONMENT",
    };
  if (context.runners === undefined)
    return { result: "skip", detail: "invalid-setting: profiles" };
  return testSignatures({ ...context, variables }, context.runners);
}
