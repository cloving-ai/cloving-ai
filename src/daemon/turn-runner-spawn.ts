import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { runnerRefusal, type TurnRunner } from "../turn-runner.ts";
import {
  runnerSetup,
  type RunnerInput,
  type RunnerStart,
} from "../cli/runner-setup.ts";

export interface RunnerLaunch {
  readonly command: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly refusal: (
    error: NodeJS.ReadableStream,
  ) => (exitCode: number | null) => string | undefined;
  readonly release: () => Promise<void>;
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
  return {
    command: setup.command,
    environment,
    refusal: refusalWatch(runner),
    release: async () => {
      rmSync(setup.folder, { recursive: true, force: true });
      if (runner.kind === "container")
        await removedContainer(runner.engine, {
          name: setup.name,
          environment,
        });
    },
  };
}
