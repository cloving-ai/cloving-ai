import { constants, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
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
import {
  harnessDefaults,
  nativeHarness,
  turnHarness,
  type HarnessSettings,
  type NativeHarness,
} from "../harness-defaults.ts";
import {
  accessibleFile,
  commandObservation,
  executableProgram,
  listedSetting,
} from "./doctor-local.ts";
import { discoverHarnesses } from "./harness-probes.ts";
import type { ProbeRunner } from "./probe-command.ts";

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
  launch: { readonly arguments: readonly string[]; readonly worker: string },
): readonly string[] {
  const arguments_ = launch.arguments;
  if (program === "node") {
    const script = arguments_[arguments_[0] === "--" ? 1 : 0];
    return script !== undefined && !script.startsWith("-")
      ? ["--", script, "--version"]
      : [];
  }
  return !nativeHarness(launch.worker) ||
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
  if (!["sh", "bash", "dash", "zsh", "ksh"].includes(shell))
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
  location: HarnessCommandLocation & { readonly worker: string },
): Promise<boolean> {
  const configured = listedSetting(command) ?? [];
  const program = configured[0];
  if (!program) return false;
  const arguments_ = await harnessVersionArguments(configured, {
    directory: location.directory,
    environment: location.commandEnvironment,
    worker: location.worker,
  });
  if (arguments_.length === 0) return false;
  const path = await executableProgram(program, {
    directory: location.directory,
    environment: location.commandEnvironment,
  });
  if (path === undefined) return false;
  const directory = await existingDirectory(location.directory);
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
): Promise<boolean> {
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
    usable: await usableHarnessCommand(command, {
      ...location,
      worker: selected.worker,
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
