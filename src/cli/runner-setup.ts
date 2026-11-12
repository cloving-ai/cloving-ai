import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  runnerCommand,
  seatbeltSettings,
  type RunnerPlaces,
  type TurnRunner,
} from "../turn-runner.ts";
import {
  commitSignatureSettings,
  gitSettingsOf,
  withGitSettings,
  type CommitSignatures,
} from "../turn-environment.ts";

export type BoxedRunner = Exclude<TurnRunner, { readonly kind: "host" }>;

export interface RunnerStart {
  readonly runner?: TurnRunner;
  readonly piInputExtension?: string;
  readonly directory: string;
  readonly folder: string;
  readonly turnId?: string;
  readonly commitSignatures?: CommitSignatures;
}

export interface RunnerInput {
  readonly command: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly serviceEnvironment: NodeJS.ProcessEnv;
}

export type RunnerSetup =
  | {
      readonly kind: "host";
      readonly command: readonly string[];
      readonly environment: NodeJS.ProcessEnv;
    }
  | {
      readonly kind: "boxed";
      readonly runner: BoxedRunner;
      readonly command: readonly string[];
      readonly environment: NodeJS.ProcessEnv;
      readonly folder: string;
      readonly name: string;
    };

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

function volumeName(directory: string): string {
  const name = basename(directory).replace(/[^A-Za-z0-9_.-]/g, "-");
  const digest = createHash("sha256").update(directory).digest("hex");
  return `cloving-modules-${name}-${digest.slice(0, 16)}`;
}

function places(
  start: RunnerStart,
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
    ...(start.piInputExtension === undefined
      ? {}
      : { piInputExtension: start.piInputExtension }),
    ...(attachments === undefined ? {} : { attachments }),
  };
}

export function runnerSetup(
  start: RunnerStart,
  launch: RunnerInput,
): RunnerSetup {
  const { runner } = start;
  const gitSettings = commitSignatureSettings(start.commitSignatures);
  if (runner === undefined || runner.kind === "host")
    return {
      kind: "host",
      command: launch.command,
      environment: withGitSettings(launch.environment, gitSettings),
    };
  const folder = mkdtempSync(join(start.folder, "runner-"));
  const placed = {
    ...places(start, { folder, environment: launch.environment }),
    gitSettings: [...gitSettingsOf(launch.environment), ...gitSettings],
  };
  if (runner.kind === "seatbelt")
    writeFileSync(
      placed.settingsFile,
      JSON.stringify(seatbeltSettings(runner, placed)),
      { mode: 0o600 },
    );
  const environment =
    runner.kind === "seatbelt"
      ? {
          ...withGitSettings(launch.environment, gitSettings),
          CLAUDE_CODE_TMPDIR: placed.temporary,
        }
      : { ...launch.serviceEnvironment, ...launch.environment };
  return {
    kind: "boxed",
    runner,
    command: runnerCommand(runner, { command: launch.command, places: placed }),
    environment,
    folder,
    name: placed.name,
  };
}
