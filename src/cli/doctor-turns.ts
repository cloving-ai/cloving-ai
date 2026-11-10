import type { DoctorObservation } from "../doctor-report.ts";
import type { ProbeOutput, ProbeRunner } from "./probe-command.ts";
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

async function testSignature(context: {
  readonly repository: string;
  readonly probe: ProbeRunner;
  readonly turn: Readonly<Record<string, string>>;
}): Promise<DoctorObservation> {
  const git = (parts: readonly string[]) =>
    context.probe("git", {
      arguments: parts,
      env: context.turn,
      directory: context.repository,
      milliseconds: signatureMilliseconds,
    });
  const signing = await git([
    "config",
    "--type=bool",
    "--get",
    "commit.gpgsign",
  ]);
  if (signing.stdout.trim() !== "true")
    return { result: "ok", detail: "Commit signatures are off" };
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
    ? { result: "ok", detail: `A turn can sign commits (gpg.format ${format})` }
    : {
        result: "fail",
        detail: `A turn cannot sign commits (gpg.format ${format}): ${signatureError(signed)}`,
      };
}

export async function commitSignatureObservation(context: {
  readonly repository: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly probe: ProbeRunner;
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
  return testSignature({
    ...context,
    turn: passedVariables(environment, {
      worker: environment["CLOVING_WORKER"] ?? "claude",
      variables,
    }),
  });
}
