import {
  turnHarness,
  type HarnessSettings,
  type NativeHarness,
} from "../harness-defaults.ts";
import { access, constants, stat } from "node:fs/promises";
import { basename, delimiter, resolve } from "node:path";
import {
  shellArguments,
  shellBlock,
  shellProbeScript,
} from "../agent-harness-shell.ts";
import {
  harnessDefinition,
  harnessVersion,
} from "../agent-harness-versions.ts";
import type { DoctorObservation } from "../doctor-report.ts";
import type { ProbeRunner } from "./probe-command.ts";
import { discoverHarnesses } from "./harness-probes.ts";
import { qualifiedNode } from "./toolchain.ts";

export function listedSetting(
  text: string | undefined,
): readonly string[] | undefined {
  try {
    const list: unknown = JSON.parse(text ?? "null");
    if (
      Array.isArray(list) &&
      list.every(
        (item: unknown) => typeof item === "string" && !item.includes("\0"),
      )
    )
      return list.map(String);
  } catch {
    return undefined;
  }
  return undefined;
}

export function nodeObservation(version: string): DoctorObservation {
  return {
    result: version === qualifiedNode ? "ok" : "fail",
    detail: `Node ${version}; workflow admission requires ${qualifiedNode}`,
  };
}

export async function executableProgram(
  program: string,
  location: {
    readonly directory: string;
    readonly environment: Readonly<NodeJS.ProcessEnv>;
  },
): Promise<string | undefined> {
  return accessibleFile(program, { ...location, mode: constants.X_OK });
}

async function accessibleFile(
  program: string,
  location: {
    readonly directory: string;
    readonly environment: Readonly<NodeJS.ProcessEnv>;
    readonly mode: number;
  },
): Promise<string | undefined> {
  const paths = program.includes("/")
    ? [program]
    : (location.environment["PATH"] ?? "")
        .split(delimiter)
        .map((directory) => resolve(location.directory, directory, program));
  for (const candidate of paths) {
    const path = resolve(location.directory, candidate);
    try {
      await access(path, location.mode);
      if ((await stat(path)).isFile()) return path;
    } catch {
      continue;
    }
  }
  return undefined;
}

export async function commandObservation(
  text: string | undefined,
  location: {
    readonly directory: string;
    readonly environment: Readonly<NodeJS.ProcessEnv>;
  },
): Promise<DoctorObservation> {
  const command = listedSetting(text);
  const program = command?.[0];
  if (!program)
    return { result: "fail", detail: "An executable command list is required" };
  const path = await executableProgram(program, location);
  return {
    result: path === undefined ? "fail" : "ok",
    detail: `${JSON.stringify(command)} from ${location.directory}; ${path ?? "program is not executable"}. Availability now does not guarantee an untracked file exists in a later worktree`,
  };
}

export async function harnessObservations(
  environment: Readonly<NodeJS.ProcessEnv>,
  location: {
    readonly directory: string;
    readonly settingsValid: boolean;
    readonly probe: ProbeRunner;
    readonly commandEnvironment: Readonly<NodeJS.ProcessEnv>;
    readonly harness?: HarnessSettings["harness"];
  },
): Promise<{
  readonly harnesses: DoctorObservation;
  readonly selected: DoctorObservation;
}> {
  const discovery = await discoverHarnesses({
    env: environment,
    probe: location.probe,
  });
  const harnesses: DoctorObservation = {
    result: discovery.entries.some((entry) => entry.working) ? "ok" : "fail",
    detail: JSON.stringify(discovery),
  };
  if (!location.settingsValid)
    return {
      harnesses,
      selected: { result: "skip", detail: "Settings files are invalid" },
    };
  return {
    harnesses,
    selected: await selectedHarnessObservation(environment, location),
  };
}

interface HarnessCommandLocation {
  readonly directory: string;
  readonly commandEnvironment: Readonly<NodeJS.ProcessEnv>;
  readonly probe: ProbeRunner;
}

function shellScriptIndex(
  arguments_: readonly string[],
  shell: string,
): number | undefined {
  const terminators = shell === "zsh" ? ["--", "-b"] : ["--"];
  let optionOperand = false;
  for (const [index, argument] of arguments_.entries()) {
    if (optionOperand) {
      optionOperand = false;
      continue;
    }
    if (terminators.includes(argument)) return index + 1;
    if (
      /^-[^-oO]*c/.test(argument) ||
      ["--command", "--version", "--help"].includes(argument)
    )
      return undefined;
    if (
      /^[-+][^-]*[oO]$/.test(argument) ||
      ["--rcfile", "--init-file", "--emulate"].includes(argument)
    ) {
      optionOperand = true;
      continue;
    }
    if (/^[-+]/.test(argument)) continue;
    return index;
  }
  return undefined;
}

async function missingFile(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
  }
}

function launcherVersionArguments(
  program: string,
  arguments_: readonly string[],
): readonly string[] {
  if (program === "node") {
    const script = arguments_[arguments_[0] === "--" ? 1 : 0];
    return script !== undefined && !script.startsWith("-")
      ? ["--", script, "--version"]
      : [];
  }
  return arguments_.length === 0 || ["claude", "codex"].includes(program)
    ? ["--version"]
    : [];
}

async function harnessVersionArguments(
  command: readonly string[],
  location: {
    readonly directory: string;
    readonly environment: Readonly<NodeJS.ProcessEnv>;
  },
): Promise<readonly string[]> {
  const [program = "", ...arguments_] = command;
  const shell = basename(program);
  if (!["sh", "bash", "dash", "zsh", "ksh"].includes(shell))
    return launcherVersionArguments(shell, arguments_);
  const index = shellScriptIndex(arguments_, shell);
  const script = index === undefined ? undefined : arguments_[index];
  if (script === undefined) return [];
  let path = resolve(location.directory, script);
  if (
    !script.includes("/") &&
    ["sh", "bash", "dash"].includes(shell) &&
    (await missingFile(path))
  )
    path =
      (await accessibleFile(script, { ...location, mode: constants.R_OK })) ??
      path;
  return [...arguments_.slice(0, index), path, "--version"];
}

async function usableHarnessCommand(
  command: string,
  location: HarnessCommandLocation,
): Promise<boolean> {
  const configured = listedSetting(command) ?? [];
  const program = configured[0];
  if (!program) return false;
  const arguments_ = await harnessVersionArguments(configured, {
    directory: location.directory,
    environment: location.commandEnvironment,
  });
  if (arguments_.length === 0) return false;
  const path = await executableProgram(program, {
    directory: location.directory,
    environment: location.commandEnvironment,
  });
  if (path === undefined) return false;
  const directory = await stat(location.directory).then(
    (entry) => (entry.isDirectory() ? location.directory : undefined),
    () => undefined,
  );
  const output = await location.probe(path, {
    arguments: arguments_,
    env: location.commandEnvironment,
    ...(directory === undefined ? {} : { directory }),
  });
  return (
    output.reason === null &&
    harnessVersion(
      output.stdout,
      harnessDefinition(basename(path)).versionPattern,
    ) !== null
  );
}

function nativeCommands(
  environment: Readonly<NodeJS.ProcessEnv>,
): Readonly<Partial<Record<NativeHarness, readonly string[]>>> {
  return Object.fromEntries(
    (["claude", "codex"] as const).flatMap((name) => {
      const command = listedSetting(
        environment[
          name === "codex" ? "CLOVING_CODEX_COMMAND" : "CLOVING_CLAUDE_COMMAND"
        ],
      );
      return command === undefined ? [] : [[name, command]];
    }),
  );
}

function selectedHarness(
  environment: Readonly<NodeJS.ProcessEnv>,
  harness: HarnessSettings["harness"],
): ReturnType<typeof turnHarness> | undefined {
  try {
    return turnHarness({
      ...(environment["CLOVING_WORKER"] === undefined
        ? {}
        : { worker: environment["CLOVING_WORKER"] }),
      workerCommands: nativeCommands(environment),
      ...(harness === undefined ? {} : { harness }),
      shell: environment["SHELL"] ?? "/bin/sh",
    });
  } catch {
    return undefined;
  }
}

async function usableShellHarness(
  selected: ReturnType<typeof turnHarness> & { readonly shell: string },
  location: HarnessCommandLocation,
): Promise<boolean> {
  const output = await location.probe(selected.shell, {
    arguments: [
      ...shellArguments("login"),
      shellProbeScript,
      "cloving-harness-probe",
      selected.command[0] ?? selected.worker,
      "shell",
    ],
    env: location.commandEnvironment,
  });
  return (
    output.reason === null &&
    harnessVersion(
      shellBlock(output.stdout, 0) ?? "",
      harnessDefinition(selected.worker).versionPattern,
    ) !== null
  );
}

async function selectedProbe(
  selected: ReturnType<typeof turnHarness>,
  location: HarnessCommandLocation,
): Promise<{
  readonly usable: boolean;
  readonly effective: DoctorObservation;
}> {
  const shell = selected.shell;
  if (shell !== undefined)
    return {
      usable: await usableShellHarness({ ...selected, shell }, location),
      effective: {
        result: "ok",
        detail: `${JSON.stringify(selected.command)} through the login shell ${shell}`,
      },
    };
  const command = JSON.stringify(selected.command);
  return {
    usable: await usableHarnessCommand(command, location),
    effective: await commandObservation(command, {
      directory: location.directory,
      environment: location.commandEnvironment,
    }),
  };
}

function configuredHarnessName(
  environment: Readonly<NodeJS.ProcessEnv>,
  harness: HarnessSettings["harness"],
): string | undefined {
  return environment["CLOVING_WORKER"] ?? harness?.name;
}

async function selectedHarnessObservation(
  environment: Readonly<NodeJS.ProcessEnv>,
  location: HarnessCommandLocation & {
    readonly harness?: HarnessSettings["harness"];
  },
): Promise<DoctorObservation> {
  const configured = configuredHarnessName(environment, location.harness);
  const selected = selectedHarness(environment, location.harness);
  if (selected === undefined)
    return {
      result: "fail",
      detail: `harness ${configured ?? "claude"}; harness-no-worker`,
    };
  const { usable, effective } = await selectedProbe(selected, location);
  const label = configured === undefined ? " (default)" : "";
  return {
    result: usable && effective.result === "ok" ? "ok" : "fail",
    detail: `harness ${selected.worker}${label}; probe ${usable ? "ok" : "failed or unsupported command"}; ${effective.detail}`,
  };
}

export function queueObservation(text: string | undefined): DoctorObservation {
  const seconds = Number(text);
  const valid =
    text !== undefined &&
    /^\d+$/.test(text) &&
    Number.isInteger(seconds) &&
    seconds >= 10 &&
    seconds <= 3600;
  return {
    result: valid ? "ok" : "fail",
    detail: valid
      ? `${String(seconds)} seconds`
      : "queue.everySeconds must be a whole number from 10 to 3600",
  };
}

export function privateTextsObservation(
  text: string | undefined,
): DoctorObservation {
  const valid =
    listedSetting(text)?.some((value) => value.trim().length > 0) === true;
  return {
    result: valid ? "ok" : "fail",
    detail: valid
      ? "Nonblank private texts configured"
      : "privateTexts needs at least one nonblank text",
  };
}
