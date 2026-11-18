import { constants, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  shellArguments,
  shellBlock,
  shellProbeScript,
} from "../agent-harness-shell.ts";
import { harnessVersionReason } from "../agent-harness-versions.ts";
import type { DoctorObservation } from "../doctor-report.ts";
import {
  harnessDefaults,
  nativeHarness,
  nativePiSelected,
  turnHarness,
  type HarnessSettings,
  type NativeHarness,
} from "../harness-defaults.ts";
import type { TurnProfiles } from "../turn-profile.ts";
import {
  accessibleFile,
  commandObservation,
  executableProgram,
  listedSetting,
} from "./doctor-local.ts";
import { configuredProfiles } from "./doctor-runners.ts";
import { discoverHarnesses, type HarnessPurpose } from "./harness-probes.ts";
import type { ProbeRunner } from "./probe-command.ts";

export async function harnessObservations(
  environment: Readonly<NodeJS.ProcessEnv>,
  location: {
    readonly directory: string;
    readonly settingsValid: boolean;
    readonly probe: ProbeRunner;
    readonly commandEnvironment: Readonly<NodeJS.ProcessEnv>;
    readonly harness?: HarnessSettings["harness"];
    readonly profiles?: TurnProfiles;
  },
): Promise<{
  readonly harnesses: DoctorObservation;
  readonly selected: DoctorObservation;
}> {
  const discovery = await discoverHarnesses({
    env: environment,
    probe: location.probe,
    harness: location.harness,
    purpose: await discoveryPurpose(environment, location),
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

export async function discoveryPurpose(
  environment: Readonly<NodeJS.ProcessEnv>,
  selection: {
    readonly harness?: HarnessSettings["harness"];
    readonly profiles?: TurnProfiles;
  },
): Promise<HarnessPurpose> {
  const worker = environment["CLOVING_WORKER"];
  const profiles = await configuredProfiles(
    environment,
    selection.profiles ?? {},
  );
  const settings = {
    ...(worker === undefined ? {} : { worker }),
    ...(selection.harness === undefined ? {} : { harness: selection.harness }),
  };
  return nativePiSelected(settings, profiles ?? {})
    ? "local-worker"
    : "factory-setup";
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

const envOptionsWithValue = ["-u", "--unset", "-C", "--chdir", "-P"];

function envProgram(arguments_: readonly string[]): {
  readonly index: number;
  readonly split: boolean;
} {
  let index = 0;
  while (index < arguments_.length) {
    const part = arguments_[index] ?? "";
    if (["-S", "--split-string"].includes(part))
      return { index: index + 1, split: true };
    if (/^(-S|--split-string=)./.test(part)) return { index, split: true };
    if (!/^(-|[A-Za-z_]\w*=)/.test(part)) return { index, split: false };
    index += envOptionsWithValue.includes(part) ? 2 : 1;
  }
  return { index, split: false };
}

const shells = ["sh", "bash", "dash", "zsh", "ksh"];

function envVersionArguments(
  arguments_: readonly string[],
  worker: string,
): readonly string[] {
  const { index, split } = envProgram(arguments_);
  if (index >= arguments_.length) return [];
  const prefix = arguments_.slice(0, index + 1);
  if (split) return [...prefix, "--version"];
  const wrapped = wrappedVersionArguments(arguments_.slice(index), worker);
  return wrapped.length === 0 ? [] : [...prefix, ...wrapped];
}

function wrappedVersionArguments(
  command: readonly string[],
  worker: string,
): readonly string[] {
  const [program = "", ...arguments_] = command;
  const name = basename(program);
  if (name === "env") return envVersionArguments(arguments_, worker);
  if (!shells.includes(name))
    return launcherVersionArguments(name, { arguments: arguments_, worker });
  const script = shellScriptIndex(arguments_, name);
  return script === undefined
    ? []
    : [...arguments_.slice(0, script + 1), "--version"];
}

function launcherVersionArguments(
  program: string,
  launch: { readonly arguments: readonly string[]; readonly worker: string },
): readonly string[] {
  const arguments_ = launch.arguments;
  if (program === "node") {
    const script = arguments_[arguments_[0] === "--" ? 1 : 0];
    return script !== undefined && !script.startsWith("-")
      ? ["--", script, "--version"]
      : [];
  }
  return launch.worker === "pi" ||
    !nativeHarness(launch.worker) ||
    arguments_.length === 0 ||
    [launch.worker, "claude", "codex"].includes(program)
    ? ["--version"]
    : [];
}

async function harnessVersionArguments(
  command: readonly string[],
  location: {
    readonly directory: string;
    readonly environment: Readonly<NodeJS.ProcessEnv>;
    readonly worker: string;
  },
): Promise<readonly string[]> {
  const [program = "", ...arguments_] = command;
  const shell = basename(program);
  if (shell === "env") return envVersionArguments(arguments_, location.worker);
  if (!shells.includes(shell))
    return launcherVersionArguments(shell, {
      arguments: arguments_,
      worker: location.worker,
    });
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

function existingDirectory(path: string): Promise<string | undefined> {
  return stat(path).then(
    (entry) => (entry.isDirectory() ? path : undefined),
    () => undefined,
  );
}

async function usableHarnessCommand(
  command: string,
  location: HarnessCommandLocation & {
    readonly worker: string;
    readonly output?: "text";
  },
): Promise<string | null> {
  const configured = listedSetting(command) ?? [];
  const program = configured[0];
  if (!program) return "unsupported-command";
  const arguments_ = await harnessVersionArguments(configured, {
    directory: location.directory,
    environment: location.commandEnvironment,
    worker: location.worker,
  });
  if (arguments_.length === 0) return "unsupported-command";
  const path = await executableProgram(program, {
    directory: location.directory,
    environment: location.commandEnvironment,
  });
  if (path === undefined) return "not-found";
  const directory = await existingDirectory(location.directory);
  const output = await location.probe(path, {
    arguments: arguments_,
    env: location.commandEnvironment,
    ...(directory === undefined ? {} : { directory }),
  });
  return (
    output.reason ??
    harnessVersionReason(output.stdout, probeName(location, basename(path)))
  );
}

function probeName(
  selected: { readonly worker: string; readonly output?: "text" },
  fallback: string,
): string {
  if (selected.worker !== "pi") return fallback === "pi" ? "" : fallback;
  return selected.output === "text" ? "" : "pi";
}

function workerCommands(
  environment: Readonly<NodeJS.ProcessEnv>,
  name: string,
): Readonly<Partial<Record<NativeHarness, readonly string[]>>> {
  const variable = harnessDefaults(name).variable;
  if (variable === undefined) return {};
  const command = listedSetting(environment[variable]);
  return command === undefined ? {} : { [name]: command };
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
      workerCommands: workerCommands(
        environment,
        configuredHarnessName(environment, harness) ?? "claude",
      ),
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
): Promise<string | null> {
  const directory = await existingDirectory(location.directory);
  const output = await location.probe(selected.shell, {
    arguments: [
      ...shellArguments("login"),
      shellProbeScript,
      "cloving-harness-probe",
      selected.command[0] ?? selected.worker,
      "shell",
    ],
    env: location.commandEnvironment,
    ...(directory === undefined ? {} : { directory }),
  });
  return (
    output.reason ??
    harnessVersionReason(
      shellBlock(output.stdout, 0) ?? "",
      probeName(selected, selected.worker),
    )
  );
}

async function selectedProbe(
  selected: ReturnType<typeof turnHarness>,
  location: HarnessCommandLocation,
): Promise<{
  readonly reason: string | null;
  readonly effective: DoctorObservation;
}> {
  const shell = selected.shell;
  if (shell !== undefined)
    return {
      reason: await usableShellHarness({ ...selected, shell }, location),
      effective: {
        result: "ok",
        detail: `${JSON.stringify(selected.command)} through the login shell ${shell}`,
      },
    };
  const command = JSON.stringify(selected.command);
  return {
    reason: await usableHarnessCommand(command, {
      ...location,
      worker: selected.worker,
      ...(selected.output === undefined ? {} : { output: selected.output }),
    }),
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

export async function selectedHarnessObservation(
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
  const { reason, effective } = await selectedProbe(selected, location);
  const label = configured === undefined ? " (default)" : "";
  return {
    result: reason === null && effective.result === "ok" ? "ok" : "fail",
    detail: `harness ${selected.worker}${label}; probe ${reason ?? "ok"}; ${effective.detail}`,
  };
}
