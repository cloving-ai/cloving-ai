import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { runScenario } from "../src/testing.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { pollingWorkflow } from "./command-polling-fixture.ts";
import { completedCheck, pollingScenario } from "./command-polling-fixture.ts";
import type { ProtectedResult } from "../src/step-bridge.ts";
import { readFile } from "node:fs/promises";

await test("CLV-233 the documented polling workflow matches the executable fixture", async () => {
  const readme = await readFile(
    new URL("../README.md", import.meta.url),
    "utf8",
  );
  assert.ok(readme.includes(pollingWorkflow.trim()));
});

await test("CLV-233 pending pending ready checks immediately and sleeps only between checks", () =>
  withFiles({ "approval.ts": pollingWorkflow }, async (root) => {
    const result = await runScenario({
      workflow: join(root, "approval.ts"),
      exportName: "approval",
      input: { cycleId: "cycle", input: { request: "merge-request-1" } },
      effectLimit: 30,
      effects: {
        "command run:approval-status": [
          { ready: false },
          { ready: false },
          { ready: true },
        ].map((response) => ({
          kind: "completed",
          operationId: "check",
          receipt: null,
          result: JSON.stringify(response),
        })),
      },
    });
    assert.deepEqual(result.outcome, {
      kind: "handoff_requested",
      cycleId: "cycle",
      promotionId: "external-condition-ready",
    });
    assert.equal(result.spent, 3);
    assert.deepEqual(
      result.requests.map(([kind]) => kind),
      ["effect", "sleep", "effect", "sleep", "effect"],
    );
    assert.deepEqual(
      result.requests.flatMap(([kind, request]) =>
        kind === "effect" ? [request.scope.round] : [],
      ),
      [1, 2, 3],
    );
  }));

await test("CLV-233 pending checks stop at the finite bound without a final sleep", async () => {
  const result = await pollingScenario(
    Array.from({ length: 3 }, () => completedCheck('{"ready":false}')),
    { maximumChecks: 3 },
  );
  assert.deepEqual(result.outcome, {
    kind: "blocked",
    cycleId: "cycle",
    evidenceId: "approval-status",
    reason: "external-condition-timeout",
  });
  assert.equal(result.spent, 3);
  assert.deepEqual(
    result.requests.map(([kind]) => kind),
    ["effect", "sleep", "effect", "sleep", "effect"],
  );
});

await test("CLV-233 ready on the first check continues without sleeping", async () => {
  const result = await pollingScenario([completedCheck('{"ready":true}')]);
  assert.deepEqual(result.outcome, {
    kind: "handoff_requested",
    cycleId: "cycle",
    promotionId: "external-condition-ready",
  });
  assert.equal(result.spent, 1);
  assert.deepEqual(
    result.requests.map(([kind]) => kind),
    ["effect"],
  );
});

await test("CLV-233 exhausted polling budget stops without an additional sleep", async () => {
  const result = await pollingScenario(
    Array.from({ length: 3 }, () => completedCheck('{"ready":false}')),
    { effectLimit: 2 },
  );
  assert.deepEqual(result.outcome, {
    kind: "blocked",
    cycleId: "cycle",
    evidenceId: "approval-status",
    reason: "budget-exhausted",
  });
  assert.equal(result.spent, 2);
  assert.deepEqual(
    result.requests.map(([kind]) => kind),
    ["effect", "sleep", "effect", "sleep", "effect"],
  );
});
const failures: readonly Exclude<
  ProtectedResult,
  { readonly kind: "completed" }
>[] = [
  { kind: "failed", operationId: "check", reason: "command-timeout" },
  { kind: "failed", operationId: "check", reason: "command-interrupted" },
  ...(["stopped", "blocked", "cancelled"] as const).map((kind) => ({
    kind,
    operationId: "check",
    reason: null,
  })),
  { kind: "refused", reason: "budget-exhausted" },
  { kind: "unavailable", reason: "no-command" },
];

for (const failure of failures)
  await test(`CLV-233 ${failure.reason ?? failure.kind} stops command polling`, async () => {
    const result = await pollingScenario([failure]);
    assert.deepEqual(result.outcome, {
      kind: "blocked",
      cycleId: "cycle",
      evidenceId: "approval-status",
      reason: failure.reason ?? failure.kind,
    });
    assert.deepEqual(
      result.requests.map(([kind]) => kind),
      ["effect"],
    );
  });

for (const output of [
  null,
  "",
  "{",
  "null",
  "false",
  "true",
  "[]",
  "{}",
  '{"ready":null}',
  '{"ready":0}',
  '{"ready":"false"}',
])
  await test(`CLV-233 invalid command output ${JSON.stringify(output)} stops polling`, async () => {
    const result = await pollingScenario([completedCheck(output)], {
      maximumChecks: 3,
    });
    assert.deepEqual(result.outcome, {
      kind: "blocked",
      cycleId: "cycle",
      evidenceId: "approval-status",
      reason: "external-condition-invalid-result",
    });
    assert.deepEqual(
      result.requests.map(([kind]) => kind),
      ["effect"],
    );
  });
