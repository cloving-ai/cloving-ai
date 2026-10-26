import { parseArgs, type ParseArgsConfig } from "node:util";

export function repositoryArguments(
  argumentsList: readonly string[],
  options: NonNullable<ParseArgsConfig["options"]>,
):
  | {
      readonly argumentsList: readonly string[];
      readonly repository: string | undefined;
    }
  | string {
  if (
    !argumentsList.some(
      (argument) =>
        argument === "--repository" || argument.startsWith("--repository="),
    )
  )
    return { argumentsList, repository: undefined };
  try {
    const parsed = parseArgs({
      args: [...argumentsList],
      options: {
        ...options,
        repository: { type: "string" },
      },
      tokens: true,
      allowPositionals: true,
      strict: false,
    });
    const selectors = parsed.tokens.filter(
      (token) => token.kind === "option" && token.name === "repository",
    );
    if (selectors.length > 1) return "repeated-option";
    const removed = new Set(
      selectors.flatMap((token) =>
        token.kind === "option" && !token.inlineValue
          ? [token.index, token.index + 1]
          : [token.index],
      ),
    );
    const repository = parsed.values["repository"];
    if (
      selectors.length > 0 &&
      (typeof repository !== "string" || repository === "")
    )
      return "missing-value";
    return {
      argumentsList: argumentsList.filter((_, index) => !removed.has(index)),
      repository: typeof repository === "string" ? repository : undefined,
    };
  } catch {
    return "missing-value";
  }
}
