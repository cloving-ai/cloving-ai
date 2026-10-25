import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  workflowFiles,
  workflowManifests,
} from "../tools/self-host-workflows.ts";
import { withFiles } from "./quality/files-fixture.ts";

await test("CLV-202 generated manifests bind explicit capability without expanding others", () => {
  const manifests = workflowManifests(
    {
      workflows: {
        "workflows/review-corpus.ts": {
          analyze: {
            workflowId: "workflow//./workflows/review-corpus//analyze",
          },
        },
        "workflows/other.ts": {
          other: { workflowId: "workflow//./workflows/other//other" },
        },
      },
    },
    [
      {
        functionName: "analyze",
        workflowId: "review-corpus",
        effectLimit: 3,
        capabilities: ["claude"],
        input: { maximumBytes: 64, fields: {} },
      },
    ],
  );
  assert.deepEqual(manifests["analyze"]?.capabilities, ["claude"]);
  assert.deepEqual(manifests["other"]?.capabilities, ["claude", "github"]);
});

await test("CLV-074 start lists every TypeScript workflow file", async () => {
  await withFiles(
    {
      "workflows/develop-ticket.ts": "export {};",
      "workflows/develop-other.ts": "export {};",
      "workflows/develop-ticket.test.ts": "export {};",
      "workflows/README.md": "Workflow documentation.",
      "workflows/folder.ts/README.md": "A directory is not a workflow file.",
    },
    async (directory) => {
      assert.deepEqual(await workflowFiles(join(directory, "workflows")), [
        "develop-other.ts",
        "develop-ticket.ts",
      ]);
    },
  );
});

await test("CLV-074 start rejects a file with more than one workflow function", () => {
  assert.throws(
    () =>
      workflowManifests({
        workflows: {
          "workflows/develop-ticket.ts": {
            developTicket: {
              workflowId: "workflow//./workflows/develop-ticket//developTicket",
            },
            developOther: {
              workflowId: "workflow//./workflows/develop-ticket//developOther",
            },
          },
        },
        steps: {},
      }),
    /workflows\/develop-ticket\.ts.*one workflow function/,
  );
});

await test("CLV-089 start refuses two files exporting the same workflow function name", () => {
  assert.throws(
    () =>
      workflowManifests({
        workflows: {
          "workflows/first.ts": {
            review: { workflowId: "workflow//./workflows/first//review" },
          },
          "workflows/second.ts": {
            review: { workflowId: "workflow//./workflows/second//review" },
          },
        },
      }),
    /duplicate-workflow-function.*review/,
  );
});

await test("CLV-074 start makes a manifest per workflow function with the file name and the shared filtered steps", () => {
  const workflowId = "workflow//./workflows/develop-ticket//developTicket";
  const otherId = "workflow//./workflows/develop-other//developOther";
  const stepId = "step//cloving/workflows/steps/load-cycle@0.4.0//loadCycle";
  const manifests = workflowManifests({
    workflows: {
      "workflows/develop-ticket.ts": { developTicket: { workflowId } },
      "workflows/develop-other.ts": {
        developOther: { workflowId: otherId },
      },
    },
    steps: {
      "node_modules/cloving/steps/load-cycle.ts": { loadCycle: { stepId } },
      "workflows/local.ts": { local: { stepId: "step//./local//local" } },
    },
  });
  const shared = {
    schemaVersion: 1,
    steps: [stepId],
    capabilities: ["claude", "github"],
    resources: [],
    artifacts: "artifacts",
  };
  assert.deepEqual(manifests, {
    developTicket: { ...shared, name: "develop-ticket", workflowId },
    developOther: {
      ...shared,
      name: "develop-other",
      workflowId: otherId,
    },
  });
});

await test("CLV-096 discovers JavaScript and TypeScript but excludes type declarations", async () => {
  await withFiles(
    {
      "workflows/alpha.js": "export {};",
      "workflows/beta.ts": "export {};",
      "workflows/alpha.d.ts": "export {};",
      "workflows/beta.declaration.json": "{}",
    },
    async (directory) => {
      assert.deepEqual(await workflowFiles(join(directory, "workflows")), [
        "alpha.js",
        "beta.ts",
      ]);
    },
  );
});

await test("CLV-096 emission preserves logical workflow names", () => {
  const workflowId = "workflow//./workflows/review-run//review";
  const compiled = (extension: string) =>
    workflowManifests({
      workflows: {
        [`workflows/review-run.${extension}`]: { review: { workflowId } },
      },
    });
  assert.deepEqual(compiled("js"), compiled("ts"));
});
