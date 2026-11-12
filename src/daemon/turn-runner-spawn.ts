import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { runnerRefusal, type TurnRunner } from "../turn-runner.ts";
import type { RunnerPlace } from "../turn-launch.ts";
import {
  runnerSetup,
  type RunnerInput,
  type RunnerStart,
} from "../cli/runner-setup.ts";

export interface RunnerLaunch {
  readonly command: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly place?: RunnerPlace;
  readonly refusal: (
    error: NodeJS.ReadableStream,
  ) => (exitCode: number | null) => string | undefined;
  readonly release: () => Promise<void>;
}

const engineVariables = [
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
] as const;

function engineEnvironment(
  environment: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    engineVariables.flatMap((name) => {
      const value = environment[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

function refusalWatch(runner: TurnRunner) {
  return (error: NodeJS.ReadableStream) => {
    let text = "";
    error.on("data", (chunk: Buffer | string) => {
      if (text.length < 65_536) text += String(chunk);
    });
    return (exitCode: number | null) =>
      runnerRefusal(runner, { exitCode, error: text });
  };
}

function removedContainer(
  engine: string,
  context: { readonly name: string; readonly environment: NodeJS.ProcessEnv },
): Promise<void> {
  return new Promise((settle) => {
    execFile(
      engine,
      ["rm", "-f", context.name],
      { env: context.environment, timeout: 30_000 },
      () => {
        settle();
      },
    );
  });
}

export async function releasedRunner(
  place: RunnerPlace | undefined,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  if (place === undefined) return;
  rmSync(place.folder, { recursive: true, force: true });
  const { container } = place;
  if (container === undefined) return;
  const cleanup = { ...environment };
  if (container.environment !== undefined)
    for (const name of engineVariables)
      cleanup[name] = container.environment[name];
  await removedContainer(container.engine, {
    name: container.name,
    environment: cleanup,
  });
}

function runnerPlace(
  runner: TurnRunner,
  place: {
    readonly folder: string;
    readonly name: string;
    readonly environment: NodeJS.ProcessEnv;
  },
): RunnerPlace {
  const { folder, name, environment } = place;
  if (runner.kind !== "container") return { folder };
  return {
    folder,
    container: {
      engine: runner.engine,
      name,
      environment: engineEnvironment(environment),
    },
  };
}

export function runnerLaunch(
  start: RunnerStart,
  launch: RunnerInput,
): RunnerLaunch {
  const setup = runnerSetup(start, launch);
  if (setup.kind === "host")
    return {
      command: setup.command,
      environment: setup.environment,
      refusal: () => () => undefined,
      release: () => Promise.resolve(),
    };
  const { runner, environment } = setup;
  const place = runnerPlace(runner, setup);
  return {
    command: setup.command,
    environment,
    place,
    refusal: refusalWatch(runner),
    release: () => releasedRunner(place, environment),
  };
}
