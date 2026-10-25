import { record } from "./protocol.ts";

export type LocalCommands = Readonly<Record<string, readonly string[]>>;

export const commandLimits = {
  stdoutBytes: 1_048_576,
  stderrBytes: 65_536,
  resultBytes: 3_145_728,
};

export interface CommandEffect {
  readonly operationId: string;
  readonly name: string;
  readonly state: string;
  readonly exitCode: number | null;
  readonly durationMilliseconds: number | null;
}

export type CommandEffects = (
  effects: readonly CommandEffect[],
) => Promise<readonly CommandEffect[]>;

function argumentsList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    typeof value[0] === "string" &&
    value[0].startsWith("/") &&
    Array.from<unknown>(value).every(
      (argument) =>
        typeof argument === "string" && !argument.includes("\u0000"),
    )
  );
}

export function parseCommands(text: string | undefined): LocalCommands {
  if (text === undefined) return {};
  try {
    const fields = record(JSON.parse(text));
    if (fields === undefined) throw new Error("invalid-commands");
    const commands: Record<string, readonly string[]> = {};
    for (const [name, argumentList] of Object.entries(fields)) {
      if (!/^[A-Za-z0-9-]{1,64}$/.test(name) || !argumentsList(argumentList))
        throw new Error("invalid-commands");
      commands[name] = [...argumentList];
    }
    return commands;
  } catch {
    throw new Error("invalid-commands");
  }
}

export function parseCommandSeconds(text: string | undefined): number {
  if (text === undefined) return 60;
  const seconds = Number(text);
  if (
    !/^\d+$/.test(text) ||
    !Number.isInteger(seconds) ||
    seconds < 1 ||
    seconds > 3600
  )
    throw new Error("invalid-command-seconds");
  return seconds;
}
