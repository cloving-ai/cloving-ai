import { parseArgs } from "node:util";

export interface ConfigInvocation {
  readonly kind: "config";
  readonly action: "list" | "get" | "set" | "unset";
  readonly field?: string;
  readonly value?: string;
  readonly private: boolean;
  readonly json: boolean;
}

const argumentCounts = { list: 1, get: 2, set: 3, unset: 2 };

function escapedValue(argumentsList: readonly string[]): {
  readonly argumentsList: readonly string[];
  readonly value?: string;
} {
  const flags = new Set(["--json", "--private", "--help", "-h"]);
  const positionals = argumentsList
    .map((value, index) => ({ value, index }))
    .filter(({ value }) => !flags.has(value));
  const [command, , value] = positionals;
  if (
    command?.value !== "set" ||
    value === undefined ||
    !value.value.startsWith("-") ||
    argumentsList.includes("--")
  )
    return { argumentsList };
  return {
    argumentsList: argumentsList.map((item, index) =>
      index === value.index ? "config-value" : item,
    ),
    value: value.value,
  };
}

function knownAction(
  value: string | undefined,
): value is ConfigInvocation["action"] {
  return value !== undefined && Object.hasOwn(argumentCounts, value);
}

function mutation(action: ConfigInvocation["action"]): boolean {
  return action === "set" || action === "unset";
}

export function configInvocation(
  argumentsList: readonly string[],
): ConfigInvocation | { readonly kind: "config-help" } | string {
  try {
    const escaped = escapedValue(argumentsList);
    const { values, positionals } = parseArgs({
      args: [...escaped.argumentsList],
      options: {
        private: { type: "boolean" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
    });
    const [action, field, parsedValue] = positionals;
    const value = escaped.value ?? parsedValue;
    if (values.help) return { kind: "config-help" };
    if (!knownAction(action)) return "unknown-command";
    if (positionals.length !== argumentCounts[action])
      return "invalid-invocation";
    if (values.private && !mutation(action)) return "unexpected-option";
    return {
      kind: "config",
      action,
      ...(field === undefined ? {} : { field }),
      ...(value === undefined ? {} : { value }),
      private: values.private === true,
      json: values.json === true,
    };
  } catch {
    return "invalid-invocation";
  }
}
