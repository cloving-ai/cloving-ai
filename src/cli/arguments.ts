import { parseArgs } from "node:util";
import { repositoryArguments } from "./repository-arguments.ts";
import { phoneInvocation, type PhoneInvocation } from "./phone-arguments.ts";
import {
  isRuntimeCommand,
  runtimeInvocation,
  type GivenOption,
  type RuntimeInvocation,
} from "./runtime-arguments.ts";

export type Invocation = { readonly repository?: string } & (
  | PhoneInvocation
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "doctor-help" }
  | { readonly kind: "doctor"; readonly json: boolean }
  | { readonly kind: "validate-help" }
  | {
      readonly kind: "validate";
      readonly manifest: string;
      readonly input: string | null;
      readonly json: boolean;
    }
  | RuntimeInvocation
  | {
      readonly kind: "usage-error";
      readonly code: string;
      readonly json: boolean;
    }
);

const errorCodes: Readonly<Record<string, string>> = {
  ERR_PARSE_ARGS_UNKNOWN_OPTION: "unknown-option",
  ERR_PARSE_ARGS_INVALID_OPTION_VALUE: "missing-value",
};

const options = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  input: { type: "string" },
  json: { type: "boolean" },
  prompt: { type: "string" },
  ticket: { type: "string" },
  next: { type: "boolean" },
  port: { type: "string" },
  text: { type: "string" },
  "command-id": { type: "string" },
  "expected-revision": { type: "string" },
  generation: { type: "string" },
  "subject-digest": { type: "string" },
  limit: { type: "string" },
  after: { type: "string" },
  follow: { type: "boolean" },
  since: { type: "string" },
  repository: { type: "string" },
} as const;

type Parsed = ReturnType<
  typeof parseArgs<{
    options: typeof options;
    allowPositionals: true;
    tokens: true;
  }>
>;

const textOptions = ["--prompt", "--text"];

function knownFlag(token: string): boolean {
  if (token.startsWith("--")) return Object.hasOwn(options, token.slice(2));
  return token === "-h" || token === "-v";
}

function attached(option: string, value: string): readonly string[] {
  return value.startsWith("-") && !knownFlag(value)
    ? [`${option}=${value}`]
    : [option, value];
}

function textValues(argumentsList: readonly string[]): readonly string[] {
  const joined: string[] = [];
  let option: string | undefined;
  for (const token of argumentsList) {
    const pending = option;
    option =
      pending === undefined && textOptions.includes(token) ? token : undefined;
    if (pending !== undefined) joined.push(...attached(pending, token));
    else if (option === undefined) joined.push(token);
  }
  return option === undefined ? joined : [...joined, option];
}

export function parseInvocation(given: readonly string[]): Invocation {
  const selected = repositoryArguments(given, options);
  if (typeof selected === "string")
    return {
      kind: "usage-error",
      code: selected,
      json: given.includes("--json"),
    };
  const invocation = selectedInvocation(selected.argumentsList);
  return selected.repository === undefined
    ? invocation
    : { ...invocation, repository: selected.repository };
}

function selectedInvocation(given: readonly string[]): Invocation {
  if (given[0] === "phone") return phoneInvocation(given.slice(1));
  const argumentsList = textValues(given);
  const json = given.includes("--json");
  const parsed = parsedArguments(argumentsList);
  if (typeof parsed === "string")
    return { kind: "usage-error", code: parsed, json };
  const { values, positionals, tokens } = parsed;
  const [command, ...remaining] = positionals;
  if (command === undefined) return topLevel(values);
  if (command === "doctor") return doctorInvocation(values, remaining);
  if (command === "workflows" && remaining[0] === "validate")
    return validation(values, remaining.slice(1));
  const outcome = runtimeInvocation({
    command,
    positionals: remaining,
    options: givenOptions(tokens),
  });
  if (typeof outcome === "string")
    return { kind: "usage-error", code: outcome, json };
  return outcome;
}

function doctorInvocation(
  values: Parsed["values"],
  remaining: readonly string[],
): Invocation {
  const json = values.json === true;
  if (unexpected(values, ["help", "json"]))
    return { kind: "usage-error", code: "unexpected-option", json };
  if (remaining.length > 0)
    return { kind: "usage-error", code: "unexpected-argument", json };
  return values.help ? { kind: "doctor-help" } : { kind: "doctor", json };
}

function parsedArguments(argumentsList: readonly string[]): Parsed | string {
  try {
    return parseArgs({
      args: [...argumentsList],
      allowPositionals: true,
      options,
      tokens: true,
    });
  } catch (error) {
    if (!knownCommand(lenientPositionals(argumentsList)))
      return "unknown-command";
    const code =
      error instanceof Error && "code" in error ? String(error.code) : "";
    return errorCodes[code] ?? "invalid-invocation";
  }
}

function lenientPositionals(
  argumentsList: readonly string[],
): readonly string[] {
  return parseArgs({
    args: [...argumentsList],
    allowPositionals: true,
    options,
    strict: false,
  }).positionals;
}

function knownCommand(positionals: readonly string[]): boolean {
  const [command, subcommand] = positionals;
  if (command === undefined) return true;
  if (command === "workflows") return subcommand === "validate";
  if (command === "doctor") return true;
  return isRuntimeCommand(command);
}

function givenOptions(tokens: Parsed["tokens"]): GivenOption[] {
  return tokens.flatMap((token) =>
    token.kind === "option" ? [{ name: token.name, value: token.value }] : [],
  );
}

function unexpected(
  values: Parsed["values"],
  allowed: readonly string[],
): boolean {
  return Object.keys(values).some((name) => !allowed.includes(name));
}

function validation(
  values: Parsed["values"],
  remaining: readonly string[],
): Invocation {
  const json = values.json === true;
  if (unexpected(values, ["help", "input", "json"]))
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
  if (unexpected(values, ["help", "version"]))
    return { kind: "usage-error", code: "unexpected-option", json };
  return values.version ? { kind: "version" } : { kind: "help" };
}
