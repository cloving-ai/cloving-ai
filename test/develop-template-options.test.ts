import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { runScenario } from "../src/testing.ts";
import {
  configuredDevelopFiles,
  completeConfigurations,
  automatic,
} from "./develop-template-options-fixture.ts";
import {
  reviewed,
  configurationErrors,
  developManifest,
} from "./develop-template-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import {
  completed,
  commit,
  input,
  verificationEffects,
} from "./develop-template-flow-fixture.ts";
import { workflowTestLoader } from "../tools/workflow-test-loader.ts";
import { testMilliseconds } from "./test-timing.ts";
import type { ProtectedResult } from "../src/step-bridge.ts";

const template = fileURLToPath(
  new URL("../templates/develop", import.meta.url),
);

async function verifyResult(result: ProtectedResult) {
  return await runScenario({
    workflow: join(template, "develop/red-green.ts"),
    exportName: "verifyRedGreen",
    input: { cycleId: input.cycleId, head: commit, round: 1 },
    effects: { "command run:red-green": [result] },
  });
}

await test("CLV-249 the source helper accepts successful verification", async () => {
  for (const verdict of ["accepted", "no-test-change"])
    assert.deepEqual(
      (await verifyResult(completed({ verdict, output: "Passed." }))).outcome,
      null,
    );
});

await test("CLV-249 the source helper preserves repair verdicts and output", async () => {
  for (const verdict of [
    "false-red",
    "red-not-assertion",
    "skipped-test",
    "green-failed",
  ])
    assert.deepEqual(
      (await verifyResult(completed({ verdict, output: "Full output.\n" })))
        .outcome,
      { reason: verdict, output: "Full output.\n" },
    );
});

await test("CLV-249 the source helper blocks unavailable and invalid results", async () => {
  const responses = [
    completed({ verdict: "prepare-failed", output: "Prepare failed." }),
    { kind: "failed" as const, operationId: "command", reason: "exit-1" },
    { kind: "refused" as const, reason: "command-not-declared" },
    { ...completed(null), result: null },
    { ...completed(null), result: "invalid JSON" },
    { ...completed(null), result: "42" },
    completed(null),
    completed({}),
    completed({ verdict: 42, output: "Invalid verdict." }),
    completed({ verdict: "accepted" }),
    completed({ verdict: "accepted", output: 42 }),
    completed({ verdict: "unknown", output: "Invalid verdict." }),
  ];
  for (const response of responses)
    assert.deepEqual((await verifyResult(response)).outcome, {
      kind: "blocked",
      cycleId: input.cycleId,
      reason: "red-green-unavailable",
      evidenceId: "red-green",
    });
});

await test("CLV-249 false-red skips review and feeds the tool output to the next fix turn", async () => {
  const selected = { ...automatic, verify: "red-green" };
  const document = await developManifest();
  assert.ok(
    document.points.some((point) => point.id === "verify"),
    "Missing verify point",
  );
  assert.deepEqual(configurationErrors(document, selected), []);
  await withFiles(
    await configuredDevelopFiles(template, selected),
    async (directory) => {
      const result = await runScenario({
        workflow: join(directory, "repo/.cloving/workflows/develop.ts"),
        exportName: "develop",
        input,
        effects: verificationEffects(["false-red", "accepted"]),
      });
      assert.deepEqual(result.outcome, {
        kind: "handoff_requested",
        cycleId: input.cycleId,
        promotionId: "pull-request-7",
        ticketStatus: "complete",
      });
      const requests = result.requests.filter(
        (request) => request[0] === "effect",
      );
      const fix = requests.find(
        (request) =>
          request[1].scope.round === 2 && request[1].method === "run-turn",
      );
      assert.ok(fix);
      assert.ok(fix[1].payload.includes("false-red"));
      assert.ok(fix[1].payload.endsWith("false-red\nFull test output."));
      const commands = requests.filter(
        (request) => request[1].method === "run:red-green",
      );
      assert.deepEqual(
        commands.map((request) => request[1]),
        [1, 2].map((round) => ({
          scope: { phase: "verify", operation: "red-green", round },
          capability: "command",
          method: "run:red-green",
          target: "red-green",
          payload: JSON.stringify({ head: commit }),
          units: 1,
        })),
      );
    },
  );
});

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
            timeout: testMilliseconds(30000),
          },
        );
        assert.match(output, /selected complete configuration/);
        assert.match(output, /selected partial policy/);
        assert.doesNotMatch(output, /not ok|✖/);
      },
    );
  });
