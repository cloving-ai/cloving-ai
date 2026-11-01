import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { ticketRegistrationTable } from "../src/daemon/ticket-registration.ts";
import {
  workflowDeclarations,
  workflowManifests,
} from "../tools/self-host-workflows.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { call, parsed, withHarness } from "./service-fixture.ts";

await test("CLV-089 repeated supported capabilities register as one capability", async () => {
  const declaration = {
    workflowId: "review-run",
    effectLimit: 14,
    capabilities: ["claude", "github", "claude"],
    input: { maximumBytes: 64, fields: {} },
  };
  const manifests = workflowManifests({
    workflows: {
      "review.ts": { review: { workflowId: "workflow//./review//review" } },
    },
  });
  await withFiles(
    {
      "review.ts": "export {};",
      "review.declaration.json": JSON.stringify(declaration),
    },
    async (directory) => {
      assert.deepEqual(await workflowDeclarations(directory, manifests), [
        {
          ...declaration,
          functionName: "review",
          capabilities: ["claude", "github"],
        },
      ]);
    },
  );
});

await test("CLV-089 declared IDs that match inherited object names run without relaxing command IDs", () =>
  withHarness(async (harness) => {
    const table = ticketRegistrationTable(
      { repository: harness.projectDirectory, command: undefined },
      ["constructor", "toString"].map((workflowId) => ({
        workflowId,
        functionName: "review",
        effectLimit: 14,
        capabilities: ["claude"],
        input: {
          maximumBytes: 64,
          fields: { rounds: { type: "integer", minimum: 1 } },
        },
      })),
    );
    const workflows = table.map((row) => ({ ...harness.registration, ...row }));
    const service = await harness.start({ workflows });
    await writeFile(
      join(harness.projectDirectory, "input.json"),
      '{"rounds":3}',
    );
    for (const workflowId of ["constructor", "toString"]) {
      const invalid = await harness.cli([
        "run",
        workflowId,
        "--input",
        "input.json",
        "--command-id",
        workflowId,
        "--json",
      ]);
      assert.equal(parsed(invalid)["code"], "invalid-option-value");
      const valid = await harness.cli([
        "run",
        workflowId,
        "--input",
        "input.json",
        "--command-id",
        `command-${workflowId}`,
        "--json",
      ]);
      assert.equal(valid.status, 0, valid.stdout + valid.stderr);
      assert.equal(parsed(valid)["workflowId"], workflowId);
    }
    const status = await call(harness, { operation: "status", parameters: {} });
    assert.deepEqual(status["workflows"], ["constructor", "toString"]);
    await service.close();
  }));
