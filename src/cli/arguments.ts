import { parseArgs } from "node:util";
import { repositoryArguments } from "./repository-arguments.ts";
import {
  isRuntimeCommand,
  runtimeInvocation,
  type GivenOption,
  type RuntimeInvocation,
} from "./runtime-arguments.ts";

export type Invocation = { readonly repository?: string } & (
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "validate-help" }
  | { readonly kind: "chats-redact-help" }
  | { readonly kind: "chats-redact"; readonly importId: string }
  | { readonly kind: "chats-import-help" }
  | {
      readonly kind: "chats-import";
      readonly paths: readonly string[];
      readonly roots?: readonly string[];
      readonly excludeProjects?: readonly string[];
      readonly previousImportId?: string;
    }
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
  if (given[0] === "chats" && given[1] === "import")
    return chatsImport(given.slice(2));
  if (given[0] === "chats" && given[1] === "redact")
    return chatsRedact(given.slice(2));
  const argumentsList = textValues(given);
  const json = given.includes("--json");
  const parsed = parsedArguments(argumentsList);
  if (typeof parsed === "string")
    return { kind: "usage-error", code: parsed, json };
  const { values, positionals, tokens } = parsed;
  const [command, ...remaining] = positionals;
  if (command === undefined) return topLevel(values);
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

function chatsRedact(argumentsList: readonly string[]): Invocation {
  if (
    argumentsList.length === 1 &&
    ["--help", "-h"].includes(String(argumentsList[0]))
  )
    return { kind: "chats-redact-help" };
  const importId = argumentsList[0];
  if (
    argumentsList.length !== 1 ||
    importId === undefined ||
    !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/.test(
      importId,
    )
  )
    return { kind: "usage-error", code: "invalid-import-id", json: false };
  return { kind: "chats-redact", importId };
}

function chatsImport(argumentsList: readonly string[]): Invocation {
  const error = (code: string): Invocation => ({
    kind: "usage-error",
    code,
    json: false,
  });
  if (
    argumentsList.length === 1 &&
    ["--help", "-h"].includes(String(argumentsList[0]))
  )
    return { kind: "chats-import-help" };
  const state: ImportArguments = {
    paths: [],
    roots: [],
    excludeProjects: [],
    literal: false,
    option: undefined,
    previousImportId: undefined,
  };
  for (const argument of argumentsList) {
    const failure = importArgument(state, argument);
    if (failure !== undefined) return error(failure);
  }
  if (state.option !== undefined) return error("missing-value");
  if (state.excludeProjects.length > 0 && state.roots.length === 0)
    return error("roots-required");
  if (state.paths.length + state.roots.length === 0)
    return error("missing-argument");
  return importInvocation(state);
}

function importInvocation(state: ImportArguments): Invocation {
  const previous =
    state.previousImportId === undefined
      ? {}
      : { previousImportId: state.previousImportId };
  return state.roots.length === 0
    ? { kind: "chats-import", paths: state.paths, ...previous }
    : {
        kind: "chats-import",
        paths: state.paths,
        ...previous,
        roots: state.roots,
        excludeProjects: state.excludeProjects,
      };
}

interface ImportArguments {
  paths: string[];
  roots: string[];
  excludeProjects: string[];
  previousImportId: string | undefined;
  literal: boolean;
  option: string | undefined;
}

function importArgument(
  state: ImportArguments,
  argument: string,
): string | undefined {
  if (state.option !== undefined) return importValue(state, argument);
  if (argument === "") return "missing-argument";
  if (state.literal) {
    state.paths.push(argument);
    return;
  }
  if (argument === "--previous-import" && state.previousImportId !== undefined)
    return "repeated-previous-import";
  if (["--root", "--exclude-project", "--previous-import"].includes(argument)) {
    state.option = argument;
    return;
  }
  if (argument === "--") {
    state.literal = true;
    return;
  }
  if (argument.startsWith("-")) return "unexpected-option";
  state.paths.push(argument);
  return;
}

function importValue(
  state: ImportArguments,
  argument: string,
): string | undefined {
  if (argument === "" || argument.startsWith("-")) return "missing-value";
  const option = state.option;
  state.option = undefined;
  if (option === "--root") {
    state.roots.push(argument);
    return;
  }
  if (option === "--exclude-project" && !validProjectName(argument))
    return "invalid-exclusion";
  if (option === "--exclude-project") {
    state.excludeProjects.push(argument);
    return;
  }
  if (
    !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/.test(
      argument,
    )
  )
    return "invalid-import-id";
  state.previousImportId = argument;
  return;
}

function validProjectName(name: string): boolean {
  return (
    name !== "." &&
    name !== ".." &&
    !["/", "\\", "\0", "*", "?", "[", "]"].some((character) =>
      name.includes(character),
    )
  );
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
