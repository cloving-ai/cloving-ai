import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { loadWorkflowFolders } from "./candidate-package-fixture.ts";
import { folderInput, operatorFiles } from "./workflow-folder-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { candidateEffectExpression } from "./workflow-candidate-fixtures.ts";

function helperFiles(scope: "project" | "user" = "project") {
  const folder =
    scope === "project"
      ? "repo/.cloving/workflows"
      : "config/cloving/workflows";
  return {
    "repo/marker": "",
    ...operatorFiles(scope, "develop"),
    [`${folder}/develop.ts`]: `
import { prompt } from "./develop/prompts.ts";
export async function develop() {
  "use workflow";
  return prompt();
}`,
    [`${folder}/develop/prompts.ts`]:
      'export function prompt() { return "earlier"; }',
  };
}

await test("CLV-216 admits a workflow importing a TypeScript helper in a subfolder", () =>
  withFiles(helperFiles(), async (directory) => {
    const result = await loadWorkflowFolders(folderInput(directory));
    assert.deepEqual(result.refusals, []);
    assert.deepEqual(
      result.candidates.map((candidate) => candidate.label),
      ["develop.ts"],
    );
  }));

await test("CLV-216 user helpers can import other helpers without workflow declarations", () =>
  withFiles(
    {
      ...helperFiles("user"),
      "config/cloving/workflows/develop/prompts.ts": `
import { text } from "./nested/text.ts";
export function prompt() { return text; }`,
      "config/cloving/workflows/develop/nested/text.ts":
        'export const text = "nested";',
    },
    async (directory) => {
      const result = await loadWorkflowFolders(folderInput(directory));
      assert.deepEqual(result.refusals, []);
      assert.deepEqual(
        result.candidates.map(({ scope, label }) => [scope, label]),
        [["user", "develop.ts"]],
      );
    },
  ));

await test("CLV-216 ignores root tests and unimported subfolder helpers but requires other root declarations", () =>
  withFiles(
    {
      ...operatorFiles("project", "develop"),
      "repo/.cloving/workflows/develop.test.ts":
        'throw new Error("never execute");',
      "repo/.cloving/workflows/develop/unused.ts": "invalid unused helper",
      "repo/.cloving/workflows/other.ts": "export function helper() {}",
    },
    async (directory) => {
      const result = await loadWorkflowFolders(folderInput(directory));
      assert.deepEqual(
        result.candidates.map(({ label }) => label),
        ["develop.ts"],
      );
      assert.deepEqual(result.refusals, [
        {
          scope: "project",
          label: "other.ts",
          codes: ["workflow-read-failed"],
        },
      ]);
    },
  ));

for (const imported of [
  "../x.ts",
  "/x.ts",
  "node:fs",
  "some-package",
  "./develop/../sibling.ts",
]) {
  await test(`CLV-216 refuses forbidden import ${imported} in a helper`, () =>
    withFiles(
      {
        ...helperFiles(),
        "repo/.cloving/workflows/develop/prompts.ts": `import { value } from ${JSON.stringify(imported)}; export function prompt() { return value; }`,
      },
      async (directory) => {
        const result = await loadWorkflowFolders(folderInput(directory));
        assert.deepEqual(result.candidates, []);
        assert.ok(result.refusals[0]?.codes.includes("forbidden-import"));
      },
    ));
}

await test("CLV-216 refuses a helper with a direct effect", () =>
  withFiles(
    {
      ...helperFiles(),
      "repo/.cloving/workflows/develop/prompts.ts":
        'export function prompt() { return fetch("https://example.invalid"); }',
    },
    async (directory) => {
      const result = await loadWorkflowFolders(folderInput(directory));
      assert.deepEqual(result.candidates, []);
      assert.deepEqual(result.refusals[0]?.codes, ["direct-effect"]);
    },
  ));

for (const kind of ["file-link", "folder-link", "directory", "pipe"]) {
  await test(`CLV-216 refuses unsafe helper ${kind}`, () =>
    withFiles(helperFiles(), async (directory) => {
      const path = join(
        directory,
        "repo/.cloving/workflows/develop",
        kind === "folder-link" ? "" : "prompts.ts",
      );
      await rename(path, path + ".saved");
      if (kind.endsWith("link")) await symlink(path + ".saved", path);
      if (kind === "directory") await mkdir(path);
      if (kind === "pipe") execFileSync("mkfifo", [path]);
      const result = await loadWorkflowFolders(folderInput(directory));
      assert.deepEqual(result.candidates, []);
      assert.deepEqual(result.refusals[0]?.codes, ["unsafe-workflow-path"]);
    }));
}

await test("CLV-216 sums workflow and helper effects against the declaration limit", () =>
  withFiles(
    {
      ...helperFiles(),
      "repo/.cloving/workflows/develop.ts": `
import { prompt } from "./develop/prompts.ts";
import { protectedEffect } from "cloving/workflows";
export async function develop() { "use workflow"; await ${candidateEffectExpression}; return await prompt(); }`,
      "repo/.cloving/workflows/develop/prompts.ts": `
import { protectedEffect } from "cloving/workflows";
export async function prompt() { return await ${candidateEffectExpression}; }`,
    },
    async (directory) => {
      const result = await loadWorkflowFolders(folderInput(directory));
      assert.deepEqual(result.candidates, []);
      assert.deepEqual(result.refusals[0]?.codes, ["effect-limit"]);
    },
  ));

await test("CLV-216 helper bytes affect the artifact digest even when the export is unused", () =>
  withFiles(helperFiles(), async (directory) => {
    const first = await loadWorkflowFolders(folderInput(directory));
    assert.deepEqual(first.refusals, []);
    await writeFile(
      join(directory, "repo/.cloving/workflows/develop/prompts.ts"),
      'export function prompt() { return "earlier"; }\nexport const unused = "changed";',
    );
    const second = await loadWorkflowFolders(folderInput(directory));
    assert.deepEqual(second.refusals, []);
    assert.notEqual(
      first.candidates[0]?.artifactDigest,
      second.candidates[0]?.artifactDigest,
    );
  }));

for (const modules of [
  "node_modules",
  "NODE_MODULES",
  "develop/Node_Modules",
  "node_moduleſ",
])
  await test(`CLV-216 refuses trusted package shadowing through ${modules}`, () =>
    withFiles(
      {
        ...operatorFiles("project", "develop"),
        "repo/.cloving/workflows/develop.ts": `
import { protectedEffect } from "cloving/workflows";
import { prompt } from "./${modules}/cloving/workflows.ts";
export async function develop() {
  "use workflow";
  prompt();
  return await ${candidateEffectExpression};
}`,
        [`repo/.cloving/workflows/${modules}/cloving/workflows.ts`]: `
export async function protectedEffect() { return { kind: "shadowed-step" }; }
export function prompt() { return "shadowed-package"; }`,
      },
      async (directory) => {
        const result = await loadWorkflowFolders(folderInput(directory));
        assert.deepEqual(result.candidates, []);
        assert.deepEqual(result.refusals[0]?.codes, ["forbidden-import"]);
      },
    ));
