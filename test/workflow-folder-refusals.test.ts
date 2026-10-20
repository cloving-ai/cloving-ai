import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { loadWorkflowFolders } from "./candidate-package-fixture.ts";
import { folderInput, operatorFiles } from "./workflow-folder-fixture.ts";
import {
  candidateDeclaration,
  combinedCandidateSource,
  validCandidateSource,
} from "./workflow-candidate-fixtures.ts";
import { withFiles } from "./quality/files-fixture.ts";

for (const [name, source, declaration, codes] of [
  [
    "missing",
    combinedCandidateSource,
    JSON.stringify(candidateDeclaration),
    ["missing-export", "undeclared-effect"],
  ],
  [
    "compiler",
    `const candidate = 1;\n${validCandidateSource}`,
    JSON.stringify(candidateDeclaration),
    ["compile-failed"],
  ],
  [
    "plain",
    validCandidateSource,
    JSON.stringify(candidateDeclaration.workflow),
    ["invalid-declaration"],
  ],
  [
    "repository",
    validCandidateSource,
    JSON.stringify({
      ...candidateDeclaration,
      repository: "untrusted-target-sentinel",
    }),
    ["invalid-declaration"],
  ],
  [
    "malformed",
    validCandidateSource,
    "{compiler-source-sentinel",
    ["invalid-declaration"],
  ],
  [
    "multiple",
    `${validCandidateSource}\nexport async function other() { "use workflow"; return 1; }`,
    JSON.stringify(candidateDeclaration),
    ["unsupported-source"],
  ],
] as const) {
  await test(`CLV-124 isolates ${name} refusal and preserves prerequisite codes`, () =>
    withFiles(
      {
        ...operatorFiles("project", "neighbor"),
        [`config/cloving/workflows/${name}.ts`]: source,
        [`config/cloving/workflows/${name}.declaration.json`]: declaration,
      },
      async (directory) => {
        const result = await loadWorkflowFolders(folderInput(directory));
        assert.deepEqual(
          result.candidates.map((entry) => entry.label),
          ["neighbor.ts"],
        );
        assert.deepEqual(result.refusals, [
          { scope: "user", label: `${name}.ts`, codes },
        ]);
        assert.equal(
          JSON.stringify(result.refusals).includes("sentinel"),
          false,
        );
        assert.equal(
          JSON.stringify(result.refusals).includes(directory),
          false,
        );
      },
    ));
}

await test("CLV-124 reports opaque labels for unsafe display names", () =>
  withFiles(
    {
      "repo/marker": "",
      "config/cloving/workflows/private\nname.ts": validCandidateSource,
      "config/cloving/workflows/private\nname.declaration.json": "{}",
    },
    async (directory) => {
      const result = await loadWorkflowFolders(folderInput(directory));
      assert.equal(result.refusals.length, 1);
      assert.match(result.refusals[0]?.label ?? "", /^file-[a-f0-9]{16}$/);
      assert.deepEqual(result.refusals[0]?.codes, ["invalid-declaration"]);
      assert.equal(JSON.stringify(result.refusals).includes("private"), false);
    },
  ));

await test("CLV-124 refuses bytes that would be changed by UTF-8 decoding", () =>
  withFiles(operatorFiles("project", "project"), async (directory) => {
    const source = validCandidateSource.replaceAll("candidate", "project");
    const [before, after] = source.split('payload: "synthetic"');
    assert.ok(before && after);
    await writeFile(
      join(directory, "repo/.cloving/workflows/project.ts"),
      Buffer.concat([
        Buffer.from(before + 'payload: "'),
        Buffer.from([255]),
        Buffer.from('"' + after),
      ]),
    );
    const result = await loadWorkflowFolders(folderInput(directory));
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.refusals, [
      { scope: "project", label: "project.ts", codes: ["unsupported-source"] },
    ]);
  }));

await test("CLV-124 a missing declaration cannot conceal a conflicting base name", () =>
  withFiles(
    {
      ...operatorFiles("project", "same"),
      "config/cloving/workflows/same.ts": validCandidateSource,
    },
    async (directory) => {
      const result = await loadWorkflowFolders(folderInput(directory));
      assert.deepEqual(result.candidates, []);
      assert.deepEqual(result.refusals, [
        { scope: "project", label: "same.ts", codes: ["workflow-conflict"] },
        {
          scope: "user",
          label: "same.ts",
          codes: ["workflow-conflict", "workflow-read-failed"],
        },
      ]);
    },
  ));
