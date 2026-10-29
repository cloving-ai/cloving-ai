import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { developFiles } from "./develop-template-flow-fixture.ts";

export const ideaTemplate = fileURLToPath(
  new URL("../templates/idea-to-issue", import.meta.url),
);
export const prefix = "repo/.cloving/workflows/";
export interface IdeaSelection {
  readonly review: string;
  readonly post: string;
  readonly next: string;
}
export const configurations = [
  { review: "turn", post: "privacy", next: "develop" },
  { review: "person", post: "privacy", next: "queue" },
  { review: "turn", post: "person", next: "nothing" },
  { review: "person", post: "person", next: "develop" },
];

export async function configuredIdeaFiles(
  selected: IdeaSelection,
  directory: string = ideaTemplate,
) {
  const files = await developFiles(directory);
  const key = prefix + "idea-to-issue.ts";
  let source = files[key];
  assert.ok(typeof source === "string");
  if (selected.review === "person")
    source = source.replace(
      'reviewByTurn as checkDraft } from "./idea-to-issue/turn.ts"',
      'reviewDraftByPerson as checkDraft } from "./idea-to-issue/review.ts"',
    );
  if (selected.post === "person")
    source = source.replace(
      'postAfterPrivacy as postDraft } from "./idea-to-issue/post.ts"',
      'postByPerson as postDraft } from "./idea-to-issue/post-person.ts"',
    );
  if (selected.next !== "develop")
    source = source.replace(
      'handoffIssue as nextIssue } from "./idea-to-issue/next.ts"',
      selected.next === "queue"
        ? 'queueIssue as nextIssue } from "./idea-to-issue/queue.ts"'
        : 'leaveIssue as nextIssue } from "./idea-to-issue/leave.ts"',
    );
  files[key] = source;
  const scenarioKey = prefix + "idea-to-issue/scenarios.ts";
  if (files[scenarioKey] !== undefined)
    files[scenarioKey] = files[scenarioKey].replace(
      /export const selection = [\s\S]*?;/,
      `export const selection = ${JSON.stringify(selected)};`,
    );
  files[prefix + "idea-to-issue.declaration.json"] = ideaDeclaration(selected);
  return files;
}

function ideaDeclaration(selected: IdeaSelection): string {
  const github = ["prepare", "create-issue", "discard"];
  if (selected.next !== "nothing") github.push("label");
  if (selected.review === "person" || selected.post === "person")
    github.push("capture-draft");
  return JSON.stringify({
    workflow: {
      workflowId: "idea-to-issue",
      effectLimit: 9,
      capabilities: ["claude", "github"],
      input: { maximumBytes: 65536, fields: { idea: { type: "string" } } },
      handoffs: selected.next === "develop" ? ["develop"] : [],
    },
    methods: { claude: ["run-turn"], github },
  });
}
