import assert from "node:assert/strict";
import { test } from "node:test";
import { errorText } from "../src/cli/error-render.ts";
import {
  refusedWorkflowLines,
  restartedJson,
  restartedLines,
  restartLines,
  serviceLines,
} from "../src/cli/restart-render.ts";

await test("CLV-306 the restart text names one run, an unknown commit and a status with no start time", () => {
  assert.deepEqual(
    serviceLines({
      serviceStartedAt: "2026-11-05T10:00:00.000Z",
      restart: { at: "gap", activeRuns: 1 },
    }),
    [
      "Service: commit unknown, started at 2026-11-05T10:00:00.000Z",
      "Restart pending: 1 run active",
    ],
  );
  assert.deepEqual(serviceLines({ restart: null }), []);
  assert.deepEqual(
    restartLines({ restart: { state: "pending", activeRuns: 3 } }),
    ["Restart pending: 3 runs active"],
  );
  assert.deepEqual(restartLines({ restart: { state: "started" } }), [
    "Restart: started, cannot cancel",
  ]);
  const empty = { before: {}, after: {}, update: undefined };
  assert.deepEqual(restartedLines(empty), [
    "Restarted: commit unknown -> unknown",
    "Started at: undefined",
  ]);
  assert.deepEqual(restartedJson(empty), {
    kind: "restarted",
    previousCommit: null,
    commit: null,
    startedAt: null,
    lanes: null,
    workflows: [],
    workflowRefusals: [],
  });
});

await test("CLV-306 the reply to a restart now lists the runs with a turn that cannot resume", () => {
  assert.deepEqual(
    restartLines({
      restart: {
        state: "pending",
        activeRuns: 2,
        unresumableRuns: ["run-shell", "run-wait"],
      },
    }),
    [
      "Restart pending: 2 runs active",
      "Runs with a turn that cannot resume: run-shell, run-wait",
    ],
  );
  assert.deepEqual(
    restartLines({
      restart: { state: "pending", activeRuns: 0, unresumableRuns: [] },
    }),
    [
      "Restart pending: 0 runs active",
      "Runs with a turn that cannot resume: none",
    ],
  );
});

await test("CLV-306 the moved error text still lists the candidates", () => {
  assert.equal(
    errorText({ code: "ambiguous", detail: "two", candidates: ["a", "b"] }),
    "ambiguous: two\nCandidates: a, b\n",
  );
});

await test("CLV-320 a refused watched workflow takes the codes of its file, else of the folder, else workflow-missing", () => {
  const before = {
    restart: {
      queueWorkflowId: "develop",
      scheduledWorkflowIds: ["nightly", "weekly"],
    },
  };
  assert.deepEqual(
    refusedWorkflowLines(before, {
      workflows: ["weekly"],
      workflowRefusals: [
        {
          scope: "user",
          label: "workflows/",
          codes: ["invalid-declaration"],
        },
      ],
    }),
    [
      "queue workflow develop: invalid-declaration",
      "scheduled workflow nightly: invalid-declaration",
    ],
  );
  assert.deepEqual(refusedWorkflowLines(before, {}), [
    "queue workflow develop: workflow-missing",
    "scheduled workflow nightly: workflow-missing",
    "scheduled workflow weekly: workflow-missing",
  ]);
  assert.deepEqual(
    refusedWorkflowLines({ restart: { queueWorkflowId: null } }, {}),
    [],
  );
});
