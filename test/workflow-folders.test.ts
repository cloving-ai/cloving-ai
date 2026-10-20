import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { loadWorkflowFolders } from "./candidate-package-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import {
  candidateDeclaration,
  validCandidateSource,
} from "./workflow-candidate-fixtures.ts";

const files = {
  "repo/.cloving/workflows/project.ts": validCandidateSource,
  "repo/.cloving/workflows/project.declaration.json": JSON.stringify({
    ...candidateDeclaration,
    workflow: { ...candidateDeclaration.workflow, workflowId: "project" },
  }),
  "config/cloving/workflows/user.ts": validCandidateSource.replaceAll(
    "candidate",
    "userWorkflow",
  ),
  "config/cloving/workflows/user.declaration.json":
    JSON.stringify(candidateDeclaration),
  "config/cloving/workflows/refused.ts": validCandidateSource.replaceAll(
    "candidate",
    "refused",
  ),
  "config/cloving/workflows/refused.declaration.json": "{}",
};
await test("CLV-124 captures and admits valid project and user neighbors without changing operator bytes", () =>
  withFiles(files, async (directory) => {
    const repository = join(directory, "repo");
    const result = await loadWorkflowFolders({
      repository,
      home: directory,
      xdgConfigHome: join(directory, "config"),
      bundled: [],
    });
    assert.equal(result.repository, repository);
    assert.deepEqual(
      result.candidates.map((entry) => [
        entry.scope,
        entry.label,
        entry.repository,
      ]),
      [
        ["project", "project.ts", repository],
        ["user", "user.ts", repository],
      ],
    );
    assert.deepEqual(result.refusals, [
      { scope: "user", label: "refused.ts", codes: ["invalid-declaration"] },
    ]);
    for (const entry of result.candidates) {
      assert.match(entry.artifactDigest, /^[a-f0-9]{64}$/);
      assert.equal(
        entry.source,
        await readFile(
          join(
            directory,
            entry.scope === "project" ? "repo/.cloving" : "config/cloving",
            "workflows",
            entry.label,
          ),
          "utf8",
        ),
      );
    }
    for (const [name, bytes] of Object.entries(files))
      assert.equal(await readFile(join(directory, name), "utf8"), bytes);
  }));
