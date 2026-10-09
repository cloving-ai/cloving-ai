import { parseArgs } from "node:util";

export type Invocation =
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "validate-help" }
  | {
      readonly kind: "validate";
      readonly manifest: string;
      readonly input: string | null;
      readonly json: boolean;
    }
  | {
      readonly kind: "usage-error";
      readonly code: string;
      readonly json: boolean;
    };

const errorCodes: Readonly<Record<string, string>> = {
  ERR_PARSE_ARGS_UNKNOWN_OPTION: "unknown-option",
  ERR_PARSE_ARGS_INVALID_OPTION_VALUE: "missing-value",
};

const options = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  input: { type: "string" },
  json: { type: "boolean" },
} as const;

type Parsed = ReturnType<
  typeof parseArgs<{ options: typeof options; allowPositionals: true }>
>;

export function parseInvocation(argumentsList: readonly string[]): Invocation {
  const json = argumentsList.includes("--json");
  const parsed = parsedArguments(argumentsList);
  if (typeof parsed === "string")
    return { kind: "usage-error", code: parsed, json };
  const { values, positionals } = parsed;
  if (positionals.length === 0) return topLevel(values);
  if (positionals[0] !== "workflows" || positionals[1] !== "validate")
    return { kind: "usage-error", code: "unknown-command", json };
  return validation(values, positionals.slice(2));
}

function parsedArguments(argumentsList: readonly string[]): Parsed | string {
  try {
    return parseArgs({
      args: [...argumentsList],
      allowPositionals: true,
      options,
    });
  } catch (error) {
    const code =
      error instanceof Error && "code" in error ? String(error.code) : "";
    return errorCodes[code] ?? "invalid-invocation";
  }
}

function validation(
  values: Parsed["values"],
  remaining: readonly string[],
): Invocation {
  const json = values.json === true;
  if (values.version)
    return { kind: "usage-error", code: "unexpected-option", json };
  if (values.help) return { kind: "validate-help" };
  const [manifest, ...extra] = remaining;
  if (manifest === undefined)
    return { kind: "usage-error", code: "missing-argument", json };
  if (extra.length > 0)
    return { kind: "usage-error", code: "unexpected-argument", json };
  return { kind: "validate", manifest, input: values.input ?? null, json };
}

function topLevel(values: Parsed["values"]): Invocation {
  const json = values.json === true;
  if (json || values.input !== undefined)
    return { kind: "usage-error", code: "unexpected-option", json };
  return values.version ? { kind: "version" } : { kind: "help" };
}
