import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { developFiles } from "./develop-template-flow-fixture.ts";
import { isCandidateDeclaration } from "../src/workflow-candidate.ts";

const prefix = "repo/.cloving/workflows/";

export const patrolTemplate = fileURLToPath(
  new URL("../templates/patrol", import.meta.url),
);
export const rescueTemplate = fileURLToPath(
  new URL("../templates/rescue-pr", import.meta.url),
);
export const packedPatrolSources = [
  "templates/patrol/patrol.test.ts",
  "templates/patrol/patrol.ts",
  "templates/patrol/patrol/pick.ts",
  "templates/patrol/patrol/rescue.ts",
  "templates/patrol/patrol/scenarios.ts",
  "templates/patrol/patrol/status.ts",
];
export const packedRescueSources = [
  "templates/rescue-pr/rescue-pr.test.ts",
  "templates/rescue-pr/rescue-pr.ts",
  "templates/rescue-pr/rescue-pr/accept.ts",
  "templates/rescue-pr/rescue-pr/input.ts",
  "templates/rescue-pr/rescue-pr/prepare.ts",
  "templates/rescue-pr/rescue-pr/pull.ts",
  "templates/rescue-pr/rescue-pr/round.ts",
  "templates/rescue-pr/rescue-pr/scenarios.ts",
  "templates/rescue-pr/rescue-pr/turn.ts",
];
export const patrolSelections = [{ act: "ask" }, { act: "now" }];
export const rescueSelections = [
  { accept: "greptile", merge: "green" },
  { accept: "person", merge: "person" },
  { accept: "turn", merge: "green" },
];

export function replaced(
  files: Record<string, string>,
  edit: {
    readonly path: string;
    readonly from: string;
    readonly to: string;
  },
): void {
  const source = files[prefix + edit.path] ?? "";
  assert.ok(source.includes(edit.from), edit.from);
  files[prefix + edit.path] = source.replace(edit.from, edit.to);
}

export function selected(
  files: Record<string, string>,
  edit: { readonly path: string; readonly selection: unknown },
): void {
  replaced(files, {
    path: edit.path,
    from:
      /export const selection = [^;]*;/.exec(
        files[prefix + edit.path] ?? "",
      )?.[0] ?? "missing selection",
    to: `export const selection = ${JSON.stringify(edit.selection)};`,
  });
}

export async function configuredPatrolFiles(
  selection: { readonly act: string },
  directory: string = patrolTemplate,
): Promise<Record<string, string>> {
  const files = await developFiles(directory);
  if (selection.act === "now")
    replaced(files, {
      path: "patrol.ts",
      from: "askPerson as pickPulls",
      to: "pickAll as pickPulls",
    });
  selected(files, { path: "patrol/scenarios.ts", selection });
  return files;
}

async function rescueDeclaration(
  directory: string,
  accept: string,
): Promise<string> {
  const declaration: unknown = JSON.parse(
    await readFile(directory + "/rescue-pr.declaration.json", "utf8"),
  );
  assert.ok(isCandidateDeclaration(declaration));
  const github = declaration.methods["github"] ?? [];
  return JSON.stringify({
    workflow: declaration.workflow,
    methods: {
      claude:
        accept === "turn" ? ["run-turn", "run-turn:review"] : ["run-turn"],
      github:
        accept === "greptile"
          ? github
          : github.filter((method) => method !== "wait-review"),
    },
  });
}

export async function configuredRescueFiles(
  selection: { readonly accept: string; readonly merge: string },
  directory: string = rescueTemplate,
): Promise<Record<string, string>> {
  const files = await developFiles(directory);
  if (selection.accept === "person") {
    replaced(files, {
      path: "rescue-pr/accept.ts",
      from: 'import { reviewByAgent } from "cloving/workflows/steps/review-by-agent";',
      to: 'import { reviewByPerson } from "cloving/workflows/steps/review-by-person";',
    });
    replaced(files, {
      path: "rescue-pr/accept.ts",
      from: 'reviewByAgent({\n    subject: subject,\n    reviewer: { kind: "greptile" },\n  })',
      to: "reviewByPerson({ subject: subject })",
    });
  }
  if (selection.accept === "turn")
    replaced(files, {
      path: "rescue-pr/accept.ts",
      from: 'reviewer: { kind: "greptile" }',
      to: 'reviewer: { kind: "turn", profile: "review" }',
    });
  if (selection.merge === "person")
    for (const [from, to] of [
      ["{ mergeWhenGreen }", "{ mergeByPerson }"],
      ["steps/merge-when-green", "steps/merge-by-person"],
      ["await mergeWhenGreen(", "await mergeByPerson("],
    ] as const)
      replaced(files, { path: "rescue-pr/round.ts", from, to });
  selected(files, { path: "rescue-pr/scenarios.ts", selection });
  files[prefix + "rescue-pr.declaration.json"] = await rescueDeclaration(
    directory,
    selection.accept,
  );
  return files;
}
