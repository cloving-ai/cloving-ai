import { readFile } from "node:fs/promises";
import type { DoctorObservation } from "../doctor-report.ts";
import { isProfilesFile, type TurnProfiles } from "../turn-profile.ts";
import type { ContainerRunner, TurnRunner } from "../turn-runner.ts";
import type { ProbeRunner } from "./probe-command.ts";

interface RunnerContext {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly probe: ProbeRunner;
  readonly repository: string;
}

export async function configuredProfiles(
  environment: Readonly<NodeJS.ProcessEnv>,
  profiles: TurnProfiles,
): Promise<TurnProfiles | undefined> {
  const path = environment["CLOVING_PROFILES"];
  if (path === undefined) return profiles;
  const text = await readFile(path, "utf8").catch(() => "");
  try {
    const value: unknown = JSON.parse(text);
    return isProfilesFile(value) ? value.profiles : undefined;
  } catch {
    return undefined;
  }
}

async function started(
  context: RunnerContext,
  call: { readonly command: string; readonly arguments: readonly string[] },
): Promise<string | null> {
  const output = await context.probe(call.command, {
    arguments: call.arguments,
    env: context.environment,
    directory: context.repository,
    milliseconds: 60_000,
  });
  return output.reason;
}

async function containerProblem(
  runner: ContainerRunner,
  context: RunnerContext,
): Promise<string | undefined> {
  const { engine, image } = runner;
  const { repository } = context;
  const version = await started(context, {
    command: engine,
    arguments: ["--version"],
  });
  if (version !== null) return `engine command not found: ${engine}`;
  const inspected = await started(context, {
    command: engine,
    arguments: ["image", "inspect", image],
  });
  if (inspected !== null) return `image not found: ${image}`;
  const mounted = await started(context, {
    command: engine,
    arguments: [
      "run",
      "--rm",
      "-v",
      `${repository}:${repository}:ro`,
      image,
      "test",
      "-d",
      repository,
    ],
  });
  return mounted === null ? undefined : `test mount failed: ${repository}`;
}

async function runnerProblem(
  runner: Exclude<TurnRunner, { readonly kind: "host" }>,
  context: RunnerContext,
): Promise<string | undefined> {
  if (runner.kind === "container") return containerProblem(runner, context);
  const command = runner.command ?? "srt";
  const reason = await started(context, { command, arguments: ["--version"] });
  return reason === null
    ? undefined
    : `sandbox runtime command not found: ${command}`;
}

export async function turnRunnerObservation(
  context: RunnerContext & { readonly profiles: TurnProfiles },
): Promise<DoctorObservation> {
  const profiles = await configuredProfiles(
    context.environment,
    context.profiles,
  );
  if (profiles === undefined)
    return { result: "fail", detail: "invalid-setting: profiles" };
  const boxed = Object.entries(profiles).flatMap(([name, profile]) =>
    profile.runner === undefined || profile.runner.kind === "host"
      ? []
      : [{ name, runner: profile.runner }],
  );
  if (boxed.length === 0)
    return { result: "ok", detail: "Each profile runs its turns on the host" };
  const problems: string[] = [];
  for (const { name, runner } of boxed) {
    const problem = await runnerProblem(runner, context);
    if (problem !== undefined) problems.push(`profile ${name}: ${problem}`);
  }
  return problems.length === 0
    ? {
        result: "ok",
        detail: `Each profile runner can start: ${boxed.map((item) => item.name).join(", ")}`,
      }
    : { result: "fail", detail: problems.join("; ") };
}
