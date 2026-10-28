import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { runScenario } from "../src/testing.ts";
import {
  configuredDevelopFiles,
  completeConfigurations,
} from "./develop-template-options-fixture.ts";
import {
  reviewed,
  configurationErrors,
  developManifest,
} from "./develop-template-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { completed, commit, input } from "./develop-template-flow-fixture.ts";
import { workflowTestLoader } from "../tools/workflow-test-loader.ts";

const template = fileURLToPath(
  new URL("../templates/develop", import.meta.url),
);

await test("CLV-221 the all-review configuration approves the immutable local commit without pushing", async () => {
  assert.deepEqual(configurationErrors(await developManifest(), reviewed), []);
  await withFiles(
    await configuredDevelopFiles(template, reviewed),
    async (directory) => {
      const result = await runScenario({
        workflow: join(directory, "repo/.cloving/workflows/develop.ts"),
        exportName: "develop",
        input,
        effects: {
          "claude run-turn": [
            completed({
              summary: "Done.\nTicket status: complete",
              commit,
              uncommitted: [],
            }),
          ],
        },
        decisions: [{ decision: "approved", answer: null }],
      });
      assert.deepEqual(result.outcome, {
        kind: "handoff_requested",
        cycleId: input.cycleId,
        promotionId: `local-${commit}`,
        ticketStatus: "complete",
      });
      assert.deepEqual(
        result.requests.map((request) => request[0]),
        ["effect", "waitForDecision"],
      );
      const gate = result.requests[1];
      assert.ok(gate && gate[0] === "waitForDecision");
      assert.equal(gate[1].kind, "approval");
      assert.ok(gate[1].prompt.includes(commit));
    },
  );
});

for (const selected of completeConfigurations)
  await test(`CLV-221 complete configuration ${Object.values(selected).join("/")} passes its template tests`, async () => {
    assert.deepEqual(
      configurationErrors(await developManifest(), selected),
      [],
    );
    await withFiles(
      await configuredDevelopFiles(template, selected),
      (directory) => {
        const output = execFileSync(
          process.execPath,
          [
            "--import",
            workflowTestLoader(),
            "--test",
            join(directory, "repo/.cloving/workflows/develop.test.ts"),
          ],
          {
            cwd: directory,
            env: { ...process.env, NODE_TEST_CONTEXT: undefined },
            encoding: "utf8",
            timeout: 30000,
          },
        );
        assert.match(output, /selected complete configuration/);
        assert.match(output, /selected partial policy/);
        assert.doesNotMatch(output, /not ok|✖/);
      },
    );
  });
