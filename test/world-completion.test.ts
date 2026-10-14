import assert from "node:assert/strict";
import { test } from "node:test";
import { execute } from "../src/authority/reducer.ts";
import { reconcileWorld } from "../src/host/world-reconciliation.ts";
import { servicePrelude, withConsumer } from "./world-host-fixture.ts";
import {
  answeredGate,
  dispatch,
  lastState,
  recorded,
  run,
} from "./authority-fixture.ts";

const running = lastState(run([...answeredGate.slice(0, 2), dispatch]));

await test("CLV-072 a compiled World workflow's blocked reason reaches the completion event and status", () =>
  withConsumer(
    `
export async function develop(input: { cycleId: string }) {
  "use workflow";
  return { kind: "blocked", cycleId: input.cycleId, reason: "Greptile gave the confidence score 4/5 in round 4", evidenceId: "review-4" };
}
`,
    async (consumer) => {
      const result = await consumer.run(`${servicePrelude}
const service = await hosted();
const runId = await submitted("blocked");
await until(async () => (await stateOf(runId)) === "completed");
const events = await asked("events", { runId, after: 0, limit: 1000 });
print({ outcome: (await asked("status", { runId })).run.outcome, payload: events.events.findLast((event) => event.type === "run.completed").payload });
await service.close();
`);
      assert.equal(result.status, 0, result.stderr);
      const reason = "Greptile gave the confidence score 4/5 in round 4";
      assert.deepEqual(result.lines, [
        {
          outcome: { kind: "blocked", reason },
          payload: { outcome: "blocked", outcomeReason: reason },
        },
      ]);
    },
  ));

async function completed(
  outcome: { readonly kind: string; readonly reason?: string } | undefined,
): Promise<unknown> {
  const commands: unknown[] = [];
  const result = await reconcileWorld({
    state: () => Promise.resolve(running),
    runs: () =>
      Promise.resolve([
        { runId: "run-1", receipt: "wrun-1", status: "completed" },
      ]),
    outcome: () => Promise.resolve(outcome),
    submit: (command) => {
      commands.push(command);
      const result = execute(running, { command, ...recorded });
      assert.equal(result.kind, "accepted");
      assert.equal(result.state.runs["run-1"]?.status, "completed");
      return Promise.resolve(result);
    },
  });
  assert.deepEqual(result.sent, ["complete-run:wrun-1 accepted"]);
  return commands;
}

const command = {
  kind: "complete-run",
  commandId: "complete-run:wrun-1",
  runId: "run-1",
  expectedRevision: 2,
};

await test("CLV-072 the host forwards completed workflow outcomes and valid blocked reasons", async () => {
  for (const reason of [
    "Greptile gave the confidence score 4/5 in round 4",
    "x".repeat(256),
  ])
    assert.deepEqual(await completed({ kind: "blocked", reason }), [
      { ...command, outcome: "blocked", outcomeReason: reason },
    ]);
  assert.deepEqual(
    await completed({ kind: "handoff_requested", reason: "ignored" }),
    [{ ...command, outcome: "handoff_requested" }],
  );
});

await test("CLV-072 the host drops invalid reasons and unknown outcome kinds so completion remains valid", async () => {
  for (const reason of [
    undefined,
    "x".repeat(257),
    `${"x".repeat(256)}\n`,
    "",
    " leading",
    "\nleading",
  ])
    assert.deepEqual(
      await completed({
        kind: "blocked",
        ...(reason === undefined ? {} : { reason }),
      }),
      [{ ...command, outcome: "blocked" }],
    );
  for (const outcome of [undefined, { kind: "other", reason: "ignored" }])
    assert.deepEqual(await completed(outcome), [command]);
});
