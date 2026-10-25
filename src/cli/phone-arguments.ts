export type PhoneCommandName = "status" | "list" | "remove" | "reset";

export type PhoneInvocation =
  | { readonly kind: "phone-help" }
  | {
      readonly kind: "phone";
      readonly command: PhoneCommandName;
      readonly deviceId: string | null;
      readonly json: boolean;
    }
  | {
      readonly kind: "usage-error";
      readonly code: string;
      readonly json: boolean;
    };

const commands: readonly PhoneCommandName[] = [
  "status",
  "list",
  "remove",
  "reset",
];

function phoneCommandName(
  name: string | undefined,
): PhoneCommandName | undefined {
  return commands.find((command) => command === name);
}

function unexpected(
  tokens: readonly string[],
  command: PhoneCommandName,
): string | undefined {
  const allowed = command === "remove" ? 1 : 0;
  const options = tokens.filter((token) => token.startsWith("-"));
  const subjects = tokens.filter((token) => !token.startsWith("-"));
  if (options.some((option) => option !== "--json")) return "unexpected-option";
  if (subjects.length > allowed) return "unexpected-argument";
  return subjects.length < allowed ? "missing-argument" : undefined;
}

export function phoneInvocation(
  argumentsList: readonly string[],
): PhoneInvocation {
  const json = argumentsList.includes("--json");
  if (argumentsList.includes("--help") || argumentsList.includes("-h"))
    return { kind: "phone-help" };
  const [name, ...rest] = argumentsList;
  const command = phoneCommandName(name);
  if (command === undefined)
    return {
      kind: "usage-error",
      code: name === undefined ? "missing-argument" : "unknown-command",
      json,
    };
  const code = unexpected(rest, command);
  if (code !== undefined) return { kind: "usage-error", code, json };
  const deviceId = rest.find((token) => !token.startsWith("-")) ?? null;
  return { kind: "phone", command, deviceId, json };
}
