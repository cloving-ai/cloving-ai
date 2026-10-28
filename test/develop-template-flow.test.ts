import assert from "node:assert/strict";
import { test } from "node:test";
import {
  workflow,
  input,
  effects,
  completed,
} from "./develop-template-flow-fixture.ts";
import { runScenario } from "../src/testing.ts";

await test("CLV-221 a failed check reaches the next turn and a run stops after three fixes", async () => {
  const scenario = effects();
  const output = "check failed\n  expected: 4\n  actual: 3\n";
  for (const key of [
    "claude run-turn",
    "github open-pr",
    "github wait-review",
  ] as const)
    scenario[key] = Array.from({ length: 4 }, () => scenario[key][0]).filter(
      (value) => value !== undefined,
    );
  scenario["github merge"] = Array.from({ length: 4 }, () =>
    completed({ reason: "check-failed", output }),
  );
  const result = await runScenario({
    workflow,
    exportName: "develop",
    input,
    effects: scenario,
  });
  const turns = result.requests.filter(
    (request) => request[0] === "effect" && request[1].method === "run-turn",
  );
  assert.equal(turns.length, 4);
  const fix = turns[1];
  assert.ok(fix && fix[0] === "effect");
  assert.ok(fix[1].payload.endsWith(output));
  assert.match(fix[1].payload, /check-failed/);
  assert.deepEqual(
    turns.map((request) => {
      assert.ok(request[0] === "effect");
      return request[1].scope.round;
    }),
    [1, 2, 3, 4],
  );
  assert.deepEqual(result.outcome, {
    kind: "blocked",
    cycleId: input.cycleId,
    reason: "check-failed",
    evidenceId: "merge",
  });
  assert.equal(
    result.requests.filter(
      (request) => request[0] === "effect" && request[1].method === "merge",
    ).length,
    4,
  );
});
