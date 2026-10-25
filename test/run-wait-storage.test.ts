import assert from "node:assert/strict";
import { after, test } from "node:test";
import { runWaitTarget } from "../src/service/run-waits.ts";
import { recorded } from "./authority-fixture.ts";
import {
  executeStored,
  opened,
  pin,
  removeTemporaryDirectories,
  temporaryDirectory,
} from "./authority-store-fixture.ts";

after(removeTemporaryDirectories);

for (const [kind, fields, outcome] of [
  ["complete-run", {}, { kind: "completed", reason: null, promotionId: null }],
  [
    "complete-run",
    { outcome: "blocked", outcomeReason: "too big" },
    { kind: "blocked", reason: "too big", promotionId: null },
  ],
  ["fail-run", {}, { kind: "failed", reason: null, promotionId: null }],
  ["cancel-run", {}, { kind: "cancelled", reason: null, promotionId: null }],
] as const)
  await test(`CLV-180 stored target outcome ${outcome.kind} survives reopening`, async () => {
    const directory = await temporaryDirectory();
    const { store } = await opened(directory);
    try {
      assert.equal(await runWaitTarget(store, "missing"), undefined);
      for (const command of [
        {
          kind: "admit-run",
          commandId: "admit",
          runId: "target",
          workflow: pin,
        },
        {
          kind: "mark-started",
          commandId: "start",
          runId: "target",
          expectedRevision: 1,
        },
      ])
        assert.equal((await executeStored(store, command)).kind, "accepted");
      assert.deepEqual(await runWaitTarget(store, "target"), {
        parentRunId: null,
        status: "running",
        endedAt: null,
        outcome: null,
      });
      assert.equal(
        (
          await executeStored(store, {
            kind,
            ...fields,
            commandId: "end",
            runId: "target",
            expectedRevision: 2,
          })
        ).kind,
        "accepted",
      );
    } finally {
      await store.close();
    }
    const reopened = await opened(directory);
    try {
      assert.deepEqual(await runWaitTarget(reopened.store, "target"), {
        parentRunId: null,
        status: outcome.kind === "blocked" ? "completed" : outcome.kind,
        endedAt: Date.parse(recorded.recordedAt),
        outcome,
      });
    } finally {
      await reopened.store.close();
    }
  });
