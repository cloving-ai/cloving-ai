import type { CommitSignatures, TurnVariables } from "./turn-environment.ts";
import type { TurnRunner } from "./turn-runner.ts";

export const defaultCommand = [
  "claude",
  "-p",
  "--output-format",
  "stream-json",
  "--verbose",
  "--permission-mode",
  "acceptEdits",
  "--allowedTools",
  "Bash,Read,Edit,Write,Glob,Grep,WebSearch,WebFetch",
  "--max-budget-usd",
  "5",
];
export const defaultCodexCommand = [
  "codex",
  "exec",
  "--json",
  "--dangerously-bypass-approvals-and-sandbox",
  "--skip-git-repo-check",
  "-",
];

export const defaultGeminiCommand = [
  "gemini",
  "--output-format",
  "stream-json",
  "--approval-mode",
  "yolo",
];

export const defaultCursorCommand = [
  "cursor-agent",
  "-p",
  "--output-format",
  "stream-json",
  "--force",
];

export const defaultOpencodeCommand = ["opencode", "run", "--format", "json"];

export const defaultGrokCommand = [
  "grok",
  "--output-format",
  "streaming-messages-json",
  "--always-approve",
  "-p",
];

export const defaultPiCommand = ["pi", "--mode", "json"];

export const defaultOmpCommand = ["omp", "--mode", "json", "--auto-approve"];

export type NativeHarness =
  | "claude"
  | "codex"
  | "gemini"
  | "grok"
  | "opencode"
  | "cursor-agent"
  | "pi"
  | "omp";

const defaultCommands = {
  claude: defaultCommand,
  codex: defaultCodexCommand,
  gemini: defaultGeminiCommand,
  grok: defaultGrokCommand,
  opencode: defaultOpencodeCommand,
  pi: defaultPiCommand,
  omp: defaultOmpCommand,
  "cursor-agent": defaultCursorCommand,
};

export interface HarnessSettings {
  readonly worker?: string;
  readonly command?: readonly string[];
  readonly workerCommands?: Readonly<
    Partial<Record<NativeHarness, readonly string[]>>
  >;
  readonly harness?: {
    readonly name?: string;
    readonly kind?: "file" | "shell";
    readonly path?: string;
    readonly command?: readonly string[];
    readonly turn?: readonly string[];
    readonly output?: "text";
  };
  readonly shell?: string;
  readonly turnVariables?: TurnVariables;
  readonly turnCommitSignatures?: CommitSignatures;
}

function matchingHarness(
  settings: HarnessSettings,
  name: string,
): NonNullable<HarnessSettings["harness"]> {
  return (settings.harness?.name ?? "claude") === name
    ? (settings.harness ?? {})
    : {};
}

function nativeCommand(
  settings: HarnessSettings,
  name: NativeHarness,
): readonly string[] {
  const command = settings.workerCommands?.[name];
  if (command !== undefined) return command;
  if (name === (settings.worker ?? "claude") && settings.command !== undefined)
    return settings.command;
  const saved = matchingHarness(settings, name);
  if (saved.command !== undefined) return saved.command;
  const defaults = harnessDefaults(name).command;
  return [saved.path ?? name, ...defaults.slice(1)];
}

export function isTurnCommand(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) return false;
  const program: unknown = value[0];
  return (
    typeof program === "string" &&
    program !== "" &&
    program !== "{prompt}" &&
    value.every(
      (part: unknown) => typeof part === "string" && !part.includes("\u0000"),
    ) &&
    value.filter((part: unknown) => part === "{prompt}").length <= 1
  );
}

export function harnessDefaults(value: unknown): {
  readonly command: readonly string[];
  readonly variable?: string;
} {
  const name =
    typeof value === "string" && nativeHarness(value) ? value : "claude";
  const variable = {
    claude: "CLOVING_CLAUDE_COMMAND",
    codex: "CLOVING_CODEX_COMMAND",
    gemini: "CLOVING_GEMINI_COMMAND",
    grok: "CLOVING_GROK_COMMAND",
    opencode: "CLOVING_OPENCODE_COMMAND",
    pi: "CLOVING_PI_COMMAND",
    omp: "CLOVING_OMP_COMMAND",
    "cursor-agent": undefined,
  }[name];
  return {
    command: defaultCommands[name],
    ...(variable === undefined ? {} : { variable }),
  };
}

function selectedCommand(
  settings: HarnessSettings,
  name: string,
): {
  readonly command: readonly string[];
  readonly output?: "text";
} {
  const saved = matchingHarness(settings, name);
  if (nativeHarness(name, saved.turn))
    return { command: nativeCommand(settings, name) };
  if (saved.turn === undefined) throw new Error(`harness-no-worker: ${name}`);
  if (!isTurnCommand(saved.turn))
    throw new Error("invalid-setting: harness.turn");
  return {
    command: saved.command ?? [
      saved.path ?? saved.turn[0] ?? "",
      ...saved.turn.slice(1),
    ],
    output: "text",
  };
}

function turnSettings(settings: HarnessSettings): {
  readonly variables: TurnVariables;
  readonly commitSignatures: CommitSignatures;
} {
  return {
    variables: settings.turnVariables ?? [],
    commitSignatures: settings.turnCommitSignatures ?? "keep",
  };
}

export function turnShell(
  settings: HarnessSettings,
  profile: { readonly harness?: string } = {},
): string | undefined {
  const name =
    profile.harness ?? settings.worker ?? settings.harness?.name ?? "claude";
  return matchingHarness(settings, name).kind === "shell"
    ? (settings.shell ?? "/bin/sh")
    : undefined;
}

export function turnHarness(
  settings: HarnessSettings,
  profile: { readonly harness?: string; readonly runner?: TurnRunner } = {},
): {
  readonly worker: string;
  readonly command: readonly string[];
  readonly shell?: string;
  readonly output?: "text";
  readonly variables: TurnVariables;
  readonly commitSignatures: CommitSignatures;
  readonly runner?: TurnRunner;
} {
  const name =
    profile.harness ?? settings.worker ?? settings.harness?.name ?? "claude";
  const shell = turnShell(settings, profile);
  return {
    worker: name,
    ...turnSettings(settings),
    ...selectedCommand(settings, name),
    ...(shell === undefined ? {} : { shell }),
    ...(profile.runner === undefined ? {} : { runner: profile.runner }),
  };
}

export function piSessionHarness(name: unknown): boolean {
  return name === "pi" || name === "omp";
}

export function nativeHarness(
  name: string,
  turn?: unknown,
): name is NativeHarness {
  return (
    Object.hasOwn(defaultCommands, name) &&
    !(piSessionHarness(name) && turn !== undefined)
  );
}
