import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyAuthority, execute, rebuild } from "../src/authority/reducer.ts";
import { admit, recorded } from "./authority-fixture.ts";

await test("CLV-179 skip events replay idempotently without altering a run or its observation", () => {
  const admitted = execute(emptyAuthority, { command: admit, ...recorded });
  assert.equal(admitted.kind, "accepted");
  const command = {
    kind: "record-schedule-skip",
    commandId: "skip:schedule:review:2",
    runId: admit.runId,
    workflowId: "review",
    slot: 2,
  };
  const skipped = execute(admitted.state, { command, ...recorded });
  assert.equal(skipped.kind, "accepted");
  assert.equal(skipped.events[0]?.type, "schedule.skipped");
  assert.deepEqual(skipped.state.runs, admitted.state.runs);
  assert.deepEqual(skipped.state.details, admitted.state.details);
  assert.deepEqual(skipped.intents, []);
  assert.deepEqual(execute(skipped.state, { command, ...recorded }), {
    kind: "duplicate",
    sequence: 2,
  });
  assert.deepEqual(
    rebuild([...admitted.events, ...skipped.events]),
    skipped.state,
  );
  for (const patch of [{ slot: 0 }, { slot: 2.5 }, { workflowId: "" }])
    assert.deepEqual(
      execute(admitted.state, {
        command: { ...command, ...patch },
        ...recorded,
      }),
      { kind: "rejected", reason: "invalid-command" },
    );
});
