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

export const defaultOpencodeCommand = ["opencode", "run", "--format", "json"];

export function defaultHarnessCommand(name: unknown): readonly string[] {
  if (name === "codex") return defaultCodexCommand;
  if (name === "opencode") return defaultOpencodeCommand;
  return defaultCommand;
}

export function harnessCommandVariable(name: unknown): string | undefined {
  if (name === "opencode") return "CLOVING_OPENCODE_COMMAND";
  if (name === "codex") return "CLOVING_CODEX_COMMAND";
  if (name === undefined || name === "claude") return "CLOVING_CLAUDE_COMMAND";
  return undefined;
}

export type NativeHarness = "claude" | "codex" | "opencode";

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
  };
  readonly shell?: string;
}

function matchingHarness(
  settings: HarnessSettings,
  name: NativeHarness,
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
  const defaults = defaultHarnessCommand(name);
  return [saved.path ?? name, ...defaults.slice(1)];
}

function nativeHarness(name: string): NativeHarness {
  if (name === "claude" || name === "codex" || name === "opencode") return name;
  throw new Error(`harness-no-worker: ${name}`);
}

export function turnHarness(
  settings: HarnessSettings,
  profile: { readonly harness?: string } = {},
): {
  readonly worker: NativeHarness;
  readonly command: readonly string[];
  readonly shell?: string;
} {
  const name = nativeHarness(
    profile.harness ?? settings.worker ?? settings.harness?.name ?? "claude",
  );
  const saved = matchingHarness(settings, name);
  return {
    worker: name,
    command: nativeCommand(settings, name),
    ...(saved.kind === "shell" ? { shell: settings.shell ?? "/bin/sh" } : {}),
  };
}
