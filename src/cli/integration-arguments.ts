export type IntegrationRequest =
  | { readonly kind: "refused"; readonly text: string }
  | {
      readonly kind: "hand-off";
      readonly argumentsList: readonly string[];
      readonly repository: string | undefined;
    };

export function integrationRequest(
  selection:
    | {
        readonly argumentsList: readonly string[];
        readonly repository: string | undefined;
      }
    | string,
): IntegrationRequest | undefined {
  if (typeof selection === "string") return undefined;
  const [command, , target] = selection.argumentsList;
  const handOff = {
    kind: "hand-off",
    argumentsList: selection.argumentsList.slice(1),
    repository: selection.repository,
  } as const;
  if (command === "mcp")
    return selection.argumentsList.some((option) =>
      /^--connection(?:=|$)/.test(option),
    )
      ? handOff
      : undefined;
  if (command !== "integrations") return undefined;
  if (target === undefined || target === "--help")
    return {
      kind: "refused",
      text: "missing-integration: run cloving --help for usage.\n",
    };
  if (target !== "mcp")
    return { kind: "refused", text: `unknown-integration: ${target}\n` };
  return handOff;
}
