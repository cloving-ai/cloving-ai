export type PhoneInvocation =
  | { readonly kind: "phone-help" }
  | {
      readonly kind: "phone";
      readonly command: "status";
      readonly json: boolean;
    }
  | {
      readonly kind: "usage-error";
      readonly code: string;
      readonly json: boolean;
    };

const commands = ["status"] as const;

function phoneCommandName(
  name: string | undefined,
): (typeof commands)[number] | undefined {
  return commands.find((command) => command === name);
}

function unexpected(tokens: readonly string[]): string | undefined {
  const token = tokens.find((given) => given !== "--json");
  if (token === undefined) return undefined;
  return token.startsWith("-") ? "unexpected-option" : "unexpected-argument";
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
  const code = unexpected(rest);
  if (code !== undefined) return { kind: "usage-error", code, json };
  return { kind: "phone", command, json };
}
