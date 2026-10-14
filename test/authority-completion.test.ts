import assert from "node:assert/strict";
import { after, test } from "node:test";
import { answeredGate, lastState, recorded, run } from "./authority-fixture.ts";
import { execute, rebuild } from "../src/authority/reducer.ts";
import {
  executeStored,
  opened,
  removeTemporaryDirectories,
  storedGate,
  temporaryDirectory,
} from "./authority-store-fixture.ts";

const completion = {
  kind: "complete-run",
  commandId: "completed",
  runId: "run-1",
  expectedRevision: 2,
};

await test("CLV-072 a blocked completion keeps its outcome and reason through reopening", async () => {
  const directory = await temporaryDirectory();
  const { store } = await opened(directory);
  try {
    for (const command of storedGate.slice(0, 2))
      assert.equal((await executeStored(store, command)).kind, "accepted");
    const outcome = { outcome: "blocked", outcomeReason: "x".repeat(256) };
    assert.equal(
      (await store.execute({ ...completion, ...outcome }, recorded)).kind,
      "accepted",
    );
    assert.deepEqual((await store.events()).at(-1)?.payload, outcome);
    const state = await store.state();
    await store.close();
    const reopened = await opened(directory);
    try {
      assert.deepEqual(await reopened.store.state(), state);
      assert.deepEqual(
        (await reopened.store.events()).at(-1)?.payload,
        outcome,
      );
    } finally {
      await reopened.store.close();
    }
  } finally {
    await store.close();
  }
});

await test("CLV-072 handoff and old completions replay without changing the run projection", () => {
  const results = run(answeredGate.slice(0, 2));
  const state = lastState(results);
  const history = results.flatMap((result) =>
    result.kind === "accepted" ? result.events : [],
  );
  for (const outcome of [
    {},
    { outcome: "handoff_requested" },
    { outcome: "blocked" },
  ]) {
    const result = execute(state, {
      command: { ...completion, ...outcome },
      ...recorded,
    });
    assert.equal(result.kind, "accepted");
    assert.deepEqual(result.events[0]?.payload, outcome);
    assert.equal(result.state.runs["run-1"]?.status, "completed");
    assert.deepEqual(rebuild([...history, ...result.events]), result.state);
  }
});

await test("CLV-072 completion rejects unknown outcomes and reasons outside the blocked contract", () => {
  const state = lastState(run(answeredGate.slice(0, 2)));
  const invalid = [
    { outcome: "unknown" },
    { outcome: "completed" },
    { outcome: 7 },
    { outcomeReason: "Blocked" },
    { outcome: "handoff_requested", outcomeReason: "Blocked" },
    ...[
      "x".repeat(257),
      `${"x".repeat(256)}\n`,
      "",
      " leading",
      "\nleading",
      7,
      null,
    ].map((outcomeReason) => ({ outcome: "blocked", outcomeReason })),
  ];
  for (const outcome of invalid)
    assert.deepEqual(
      execute(state, { command: { ...completion, ...outcome }, ...recorded }),
      { kind: "rejected", reason: "invalid-command" },
    );
});

after(removeTemporaryDirectories);
