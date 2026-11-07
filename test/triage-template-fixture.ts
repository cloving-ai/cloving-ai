import { fileURLToPath } from "node:url";
import { developFiles } from "./develop-template-flow-fixture.ts";
import { replaced, selected } from "./rescue-template-options-fixture.ts";

export const triageTemplate = fileURLToPath(
  new URL("../templates/triage-issue", import.meta.url),
);
export const packedTriageSources = [
  "templates/triage-issue/triage-issue.test.ts",
  "templates/triage-issue/triage-issue.ts",
  "templates/triage-issue/triage-issue/input.ts",
  "templates/triage-issue/triage-issue/pass.ts",
  "templates/triage-issue/triage-issue/post.ts",
  "templates/triage-issue/triage-issue/scenarios.ts",
  "templates/triage-issue/triage-issue/triage-candidates.mts",
  "templates/triage-issue/triage-issue/triage-queue.mts",
  "templates/triage-issue/triage-issue/turn.ts",
  "templates/triage-issue/triage-issue/verdict.ts",
];
export const triageSelections = [{ post: "person" }, { post: "now" }];

export async function configuredTriageFiles(
  selection: { readonly post: string },
  directory: string = triageTemplate,
): Promise<Record<string, string>> {
  const files = await developFiles(directory);
  if (selection.post === "now")
    replaced(files, {
      path: "triage-issue.ts",
      from: "askPerson as decidePost",
      to: "postAtOnce as decidePost",
    });
  selected(files, { path: "triage-issue/scenarios.ts", selection });
  return files;
}
