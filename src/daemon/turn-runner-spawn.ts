import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  runnerCommand,
  runnerRefusal,
  seatbeltSettings,
  type RunnerPlaces,
  type TurnRunner,
} from "../turn-runner.ts";
import type { RunnerPlace } from "../turn-launch.ts";

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

export function gitCommonFolder(directory: string): string {
  const dotGit = join(directory, ".git");
  if (!statSync(dotGit).isFile()) return dotGit;
  const linked = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1];
  if (linked === undefined) return dotGit;
  const gitFolder = resolve(directory, linked.trim());
  const common = join(gitFolder, "commondir");
  return statSync(common, { throwIfNoEntry: false })?.isFile() === true
    ? resolve(gitFolder, readFileSync(common, "utf8").trim())
    : gitFolder;
}

function containerName(turnId: string | undefined): string {
  const name = (turnId ?? "turn").replace(/[^A-Za-z0-9_.-]/g, "-");
  return `cloving-${name}-${Date.now().toString(36)}`;
}

export function volumeName(directory: string): string {
  const name = basename(directory).replace(/[^A-Za-z0-9_.-]/g, "-");
  const digest = createHash("sha256").update(directory).digest("hex");
  return `cloving-modules-${name}-${digest.slice(0, 16)}`;
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

function places(
  start: { readonly directory: string; readonly turnId?: string },
  launch: {
    readonly folder: string;
    readonly environment: NodeJS.ProcessEnv;
  },
): RunnerPlaces {
  const temporary = join(launch.folder, "tmp");
  mkdirSync(temporary);
  const attachments = launch.environment["CLOVING_ATTACHMENTS_DIRECTORY"];
  return {
    directory: start.directory,
    commonFolder: gitCommonFolder(start.directory),
    temporary,
    settingsFile: join(launch.folder, "srt-settings.json"),
    name: containerName(start.turnId),
    volume: volumeName(start.directory),
    variables: Object.keys(launch.environment),
    ...(attachments === undefined ? {} : { attachments }),
  };
}

export function runnerLaunch(
  start: {
    readonly runner?: TurnRunner;
    readonly directory: string;
    readonly folder: string;
    readonly turnId?: string;
  },
  launch: {
    readonly command: readonly string[];
    readonly environment: NodeJS.ProcessEnv;
    readonly serviceEnvironment: NodeJS.ProcessEnv;
  },
): RunnerLaunch {
  const { runner } = start;
  if (runner === undefined || runner.kind === "host")
    return {
      command: launch.command,
      environment: launch.environment,
      refusal: () => () => undefined,
      release: () => Promise.resolve(),
    };
  const folder = mkdtempSync(join(start.folder, "runner-"));
  const placed = places(start, { folder, environment: launch.environment });
  if (runner.kind === "seatbelt")
    writeFileSync(
      placed.settingsFile,
      JSON.stringify(seatbeltSettings(runner, placed)),
      { mode: 0o600 },
    );
  const environment =
    runner.kind === "seatbelt"
      ? { ...launch.environment, CLAUDE_CODE_TMPDIR: placed.temporary }
      : { ...launch.serviceEnvironment, ...launch.environment };
  const place = runnerPlace(runner, {
    folder,
    name: placed.name,
    environment,
  });
  return {
    command: runnerCommand(runner, { command: launch.command, places: placed }),
    environment,
    place,
    refusal: refusalWatch(runner),
    release: () => releasedRunner(place, environment),
  };
}
