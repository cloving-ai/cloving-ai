import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { record } from "../src/protocol.ts";
import { admitCompiled } from "../src/cli/validate.ts";
import {
  admitWorkflowCandidate,
  preparedProject,
} from "./candidate-package-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import {
  feedDeclaration,
  feedSource,
  feedEffect,
} from "./workflow-feed-fixture.ts";

await test("CLV-362 the SDK compiler admits both workflow functions", async () => {
  const result = await admitWorkflowCandidate({
    source: feedSource(`return ${feedEffect("issues")};`),
    declaration: feedDeclaration,
  });
  assert.equal(result.kind, "admitted", JSON.stringify(result));
});

await test("CLV-362 a bundle retains distinct admitted manifests for the work and feed functions", async () => {
  await withFiles(
    {
      ".cloving/workflows/triage.ts": feedSource(
        "return { picks: [], skipped: [] };",
      ),
      ".cloving/workflows/triage.declaration.json":
        JSON.stringify(feedDeclaration),
    },
    async (directory) => {
      const result = preparedProject({
        project: join(directory, "host/project"),
        repository: directory,
        home: join(directory, "home"),
        xdgConfigHome: join(directory, "configuration"),
      });
      assert.deepEqual(result["declarations"], [
        { ...feedDeclaration.workflow, functionName: "triage" },
      ]);
      const manifests = record(result["manifests"]);
      assert.ok(manifests);
      assert.deepEqual(Object.keys(manifests).sort(), ["triage", "triageFeed"]);
      assert.notEqual(manifests["triage"], manifests["triageFeed"]);
      for (const name of ["triage", "triageFeed"]) {
        const path: unknown = manifests[name];
        assert.equal(typeof path, "string");
        assert.ok(typeof path === "string");
        const manifest = record(JSON.parse(await readFile(path, "utf8")));
        assert.ok(manifest);
        assert.ok(String(manifest["workflowId"]).endsWith(`//${name}`));
        assert.equal(
          (
            await admitCompiled(path, {
              file: "triage",
              capabilities: feedDeclaration.workflow.capabilities,
            })
          ).kind,
          "admitted",
        );
      }
    },
  );
});
