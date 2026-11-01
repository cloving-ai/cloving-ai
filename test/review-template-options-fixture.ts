import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { developFiles } from "./develop-template-flow-fixture.ts";
import { isCandidateDeclaration } from "../src/workflow-candidate.ts";

export const reviewTemplate = fileURLToPath(
  new URL("../templates/review-day", import.meta.url),
);
export const reviewPrefix = "repo/.cloving/workflows/";
export const reviewSelections = [
  { post: "privacy", next: "idea" },
  { post: "result", next: "idea" },
  { post: "privacy", next: "nothing" },
  { post: "result", next: "nothing" },
];

export async function configuredReviewFiles(
  selected: {
    readonly post: string;
    readonly next: string;
  },
  directory: string = reviewTemplate,
) {
  const files = await developFiles(directory);
  const key = reviewPrefix + "review-day.ts";
  const source = files[key];
  assert.ok(source);
  let configured = source;
  if (selected.post === "result")
    configured = configured
      .replace(
        'import { postAfterPrivacy as postReport } from "./review-day/post.ts";\n',
        "",
      )
      .replace("    await postReport(input, text);\n", "");
  if (selected.next === "nothing")
    configured = configured
      .replace(
        'import { handoffProposal as nextProposal } from "./review-day/next.ts";\n',
        "",
      )
      .replace(
        "    const proposal = await chooseProposal(input, report.proposals);\n    if (proposal !== null) await nextProposal(input, proposal);",
        "    await chooseProposal(input, report.proposals);",
      );
  files[key] = configured;
  const scenarioKey = reviewPrefix + "review-day/scenarios.ts";
  assert.ok(files[scenarioKey]);
  files[scenarioKey] = files[scenarioKey].replace(
    /export const selection = [\s\S]*?;/,
    `export const selection = ${JSON.stringify(selected)};`,
  );
  files[reviewPrefix + "review-day.declaration.json"] = await reviewDeclaration(
    directory,
    selected,
  );
  return files;
}

async function reviewDeclaration(
  directory: string,
  selected: { readonly post: string; readonly next: string },
): Promise<string> {
  const declaration: unknown = JSON.parse(
    await readFile(directory + "/review-day.declaration.json", "utf8"),
  );
  assert.ok(isCandidateDeclaration(declaration));
  const github = [
    ...(selected.post === "privacy" ? ["create-issue"] : []),
    ...(selected.post === "privacy" || selected.next === "idea"
      ? ["label"]
      : []),
  ];
  return JSON.stringify({
    ...declaration,
    workflow: {
      ...declaration.workflow,
      capabilities: github.length
        ? ["command", "claude", "github"]
        : ["command", "claude"],
      handoffs: selected.next === "idea" ? ["idea-to-issue"] : [],
    },
    methods: {
      command: declaration.methods["command"],
      claude: declaration.methods["claude"],
      ...(github.length ? { github } : {}),
    },
  });
}
