import { fileURLToPath } from "node:url";
import { developFiles } from "./develop-template-flow-fixture.ts";
import {
  acceptDeclaration,
  acceptEdits,
  replaced,
  selected,
} from "./rescue-template-options-fixture.ts";

export const releaseTemplate = fileURLToPath(
  new URL("../templates/release", import.meta.url),
);
export const packedReleaseSources = [
  "templates/release/release.test.ts",
  "templates/release/release.ts",
  "templates/release/release/accept.ts",
  "templates/release/release/input.ts",
  "templates/release/release/outcome.ts",
  "templates/release/release/publish.ts",
  "templates/release/release/pull.ts",
  "templates/release/release/pulls.ts",
  "templates/release/release/refusal-tests.ts",
  "templates/release/release/round.ts",
  "templates/release/release/scenarios.ts",
  "templates/release/release/tag.ts",
  "templates/release/release/version.ts",
];
export const releaseSelections = [
  { accept: "greptile", publish: "person" },
  { accept: "person", publish: "merge" },
  { accept: "turn", publish: "person" },
];

export async function configuredReleaseFiles(
  selection: { readonly accept: string; readonly publish: string },
  directory: string = releaseTemplate,
): Promise<Record<string, string>> {
  const files = await developFiles(directory);
  acceptEdits(files, { path: "release/accept.ts", accept: selection.accept });
  if (selection.publish === "merge")
    replaced(files, {
      path: "release.ts",
      from: "askPerson as approvePublish",
      to: "afterMerge as approvePublish",
    });
  selected(files, { path: "release/scenarios.ts", selection });
  files["repo/.cloving/workflows/release.declaration.json"] =
    await acceptDeclaration(
      directory + "/release.declaration.json",
      selection.accept,
    );
  return files;
}
