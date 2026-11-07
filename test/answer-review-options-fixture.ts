import { fileURLToPath } from "node:url";
import { developFiles } from "./develop-template-flow-fixture.ts";
import { replaced, selected } from "./rescue-template-options-fixture.ts";

export const answerTemplate = fileURLToPath(
  new URL("../templates/answer-review", import.meta.url),
);
export const packedAnswerSources = [
  "templates/answer-review/answer-review.test.ts",
  "templates/answer-review/answer-review.ts",
  "templates/answer-review/answer-review/input.ts",
  "templates/answer-review/answer-review/pull.ts",
  "templates/answer-review/answer-review/replies.ts",
  "templates/answer-review/answer-review/resolve.ts",
  "templates/answer-review/answer-review/scenarios.ts",
  "templates/answer-review/answer-review/threads.ts",
  "templates/answer-review/answer-review/turn.ts",
];
export const answerSelections = [{ resolve: "bot-fix" }, { resolve: "never" }];

export async function configuredAnswerFiles(
  selection: { readonly resolve: string },
  directory: string = answerTemplate,
): Promise<Record<string, string>> {
  const files = await developFiles(directory);
  if (selection.resolve === "never")
    replaced(files, {
      path: "answer-review/replies.ts",
      from: "resolveAfterFix as resolveThread",
      to: "neverResolve as resolveThread",
    });
  selected(files, { path: "answer-review/scenarios.ts", selection });
  return files;
}
