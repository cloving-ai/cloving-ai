import assert from "node:assert/strict";
import { admittedDetails } from "../src/authority/details.ts";
import { test } from "node:test";
import {
  emptyAuthority,
  execute,
  rebuild,
  type AuthorityState,
} from "../src/authority/reducer.ts";

import { recorded } from "./authority-fixture.ts";
const startIntent = {
  kind: "start-run",
  runId: "run-1",
  operationId:
    '["cloving-operation",0,"run-1","admission","start-run",null,null]',
};

await test("CLV-006 an admitted run command records the run and one unsent start intent", () => {
  assert.deepEqual(
    execute(emptyAuthority, {
      command: {
        kind: "admit-run",
        commandId: "command-1",
        runId: "run-1",
        workflow: "pin-1",
      },
      ...recorded,
    }),
    {
      kind: "accepted",
      events: [
        {
          sequence: 1,
          type: "run.created",
          runId: "run-1",
          commandId: "command-1",
          recordedAt: "2026-10-09T00:00:00Z",
          request:
            '{"commandId":"command-1","kind":"admit-run","runId":"run-1","workflow":"pin-1"}',
          payload: { workflow: "pin-1" },
        },
      ],
      state: {
        sequence: 1,
        runs: {
          "run-1": {
            runId: "run-1",
            status: "queued",
            revision: 1,
            workflow: "pin-1",
            pausedFrom: null,
            gates: [],
          },
        },
        commands: {
          "command-1": {
            request:
              '{"commandId":"command-1","kind":"admit-run","runId":"run-1","workflow":"pin-1"}',
            sequence: 1,
          },
        },
        intents: [startIntent],
        gates: {},
        details: { "run-1": admittedDetails("run-1", {}) },
        questions: 0,
      },
      intents: [startIntent],
    },
  );
});

function admitted(
  state: AuthorityState,
  identity: { readonly commandId: string; readonly runId: string },
): ReturnType<typeof execute> {
  return execute(state, {
    command: { kind: "admit-run", ...identity, workflow: "pin-1" },
    ...recorded,
  });
}

await test("CLV-006 replaying committed events into an empty projection yields identical state", () => {
  const first = admitted(emptyAuthority, {
    commandId: "command-1",
    runId: "run-1",
  });
  assert.equal(first.kind, "accepted");
  const second = admitted(first.state, {
    commandId: "command-2",
    runId: "run-2",
  });
  assert.equal(second.kind, "accepted");
  const events = [...first.events, ...second.events];
  const rebuilt = rebuild(events);
  assert.deepEqual(rebuilt, second.state);
  assert.equal(JSON.stringify(rebuilt), JSON.stringify(second.state));
  assert.equal(JSON.stringify(rebuild(events)), JSON.stringify(rebuilt));
});

await test("CLV-006 a repeated command returns its receipt once and conflicting reuse is rejected", () => {
  const first = admitted(emptyAuthority, {
    commandId: "command-1",
    runId: "run-1",
  });
  assert.equal(first.kind, "accepted");
  assert.deepEqual(
    admitted(first.state, { commandId: "command-1", runId: "run-1" }),
    {
      kind: "duplicate",
      sequence: 1,
    },
  );
  assert.deepEqual(
    admitted(first.state, { commandId: "command-1", runId: "run-2" }),
    {
      kind: "rejected",
      reason: "conflicting-command",
    },
  );
  assert.deepEqual(
    admitted(first.state, { commandId: "command-2", runId: "run-1" }),
    {
      kind: "rejected",
      reason: "existing-run",
    },
  );
});
