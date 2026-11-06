import assert from "node:assert/strict";
import { test } from "node:test";
import { errorText } from "../src/cli/error-render.ts";
import {
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
  assert.deepEqual(restartedLines(undefined, {}), [
    "Restarted: commit unknown -> unknown",
    "Started at: undefined",
  ]);
  assert.deepEqual(restartedJson(undefined, {}), {
    kind: "restarted",
    previousCommit: null,
    commit: null,
    startedAt: null,
  });
});

await test("CLV-306 the moved error text still lists the candidates", () => {
  assert.equal(
    errorText({ code: "ambiguous", detail: "two", candidates: ["a", "b"] }),
    "ambiguous: two\nCandidates: a, b\n",
  );
});
