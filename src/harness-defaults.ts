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

export type NativeHarness =
  "claude" | "codex" | "gemini" | "grok" | "opencode" | "cursor-agent";

const defaultCommands = {
  claude: defaultCommand,
  codex: defaultCodexCommand,
  gemini: defaultGeminiCommand,
  grok: defaultGrokCommand,
  opencode: defaultOpencodeCommand,
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
  if (nativeHarness(name)) return { command: nativeCommand(settings, name) };
  const saved = matchingHarness(settings, name);
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

export function turnHarness(
  settings: HarnessSettings,
  profile: { readonly harness?: string } = {},
): {
  readonly worker: string;
  readonly command: readonly string[];
  readonly shell?: string;
  readonly output?: "text";
} {
  const name =
    profile.harness ?? settings.worker ?? settings.harness?.name ?? "claude";
  const saved = matchingHarness(settings, name);
  return {
    worker: name,
    ...selectedCommand(settings, name),
    ...(saved.kind === "shell" ? { shell: settings.shell ?? "/bin/sh" } : {}),
  };
}

export function nativeHarness(name: string): name is NativeHarness {
  return Object.hasOwn(defaultCommands, name);
}
