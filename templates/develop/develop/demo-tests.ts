import assert from "node:assert/strict";
import type { ProtectedResult } from "cloving/workflows";
import {
  fakeStepBridge,
  type ScenarioRequest,
} from "cloving/workflows/testing";
import { recordDemo } from "./demo.ts";
import { ticketInput } from "./report.ts";
import { commit, completed, input } from "./scenarios.ts";

const demo = {
  input: ticketInput(input),
  round: 2,
  pull: { number: 7, url: "pull/7", commit, target: input.cycleId },
};
const recorded = completed({
  summary: "Recorded.\nDemo status: recorded\n",
  demoStatus: "recorded",
});
const attached = completed({ number: 7, url: "https://github.com/acme/demo" });
const uploadFailed: ProtectedResult = {
  kind: "failed",
  operationId: "attach",
  reason: "github-network-failed",
};
const blocked = {
  kind: "blocked",
  cycleId: input.cycleId,
  reason: "demo-failed",
  evidenceId: "demo",
};

function steps(requests: readonly ScenarioRequest[]) {
  return requests.map((request) => {
    assert.ok(request[0] === "effect");
    return `${request[1].method} ${request[1].scope.key ?? ""}`;
  });
}

function payloads(requests: readonly ScenarioRequest[]) {
  return requests.map((request) => {
    assert.ok(request[0] === "effect");
    return request[1].payload;
  });
}

const failures: readonly (readonly [ProtectedResult, string])[] = [
  [
    { kind: "stopped", operationId: "turn", reason: null },
    "The demo turn ended stopped.",
  ],
  [
    { kind: "unavailable", reason: "cloving-host-unavailable" },
    "The demo turn ended cloving-host-unavailable.",
  ],
  [completed(null), "The demo turn gave no report."],
  [completed({ summary: 42 }), "The demo turn gave no report."],
  [
    completed({ summary: "Demo status: recorded\nThe frames are wrong." }),
    "Demo status: recorded\nThe frames are wrong.",
  ],
];

export const demoTests = [
  {
    name: "CLV-315 a recorded demo uploads the video once",
    run: async () => {
      using bridge = fakeStepBridge({
        effects: {
          "claude run-turn": [recorded],
          "github attach-asset": [attached],
        },
      });
      assert.equal(await recordDemo(demo), null);
      assert.deepEqual(steps(bridge.requests), [
        "run-turn attempt-1",
        "attach-asset attempt-1",
      ]);
      const request = bridge.requests[0];
      assert.ok(request !== undefined && request[0] === "effect");
      assert.deepEqual(request[1].scope, {
        phase: "demo",
        operation: "claude-turn",
        round: 2,
        key: "attempt-1",
      });
    },
  },
  {
    name: "CLV-315 the kept demo status decides when the summary limit cut the last line",
    run: async () => {
      using bridge = fakeStepBridge({
        effects: {
          "claude run-turn": [
            completed({ summary: "語".repeat(16_000), demoStatus: "recorded" }),
          ],
          "github attach-asset": [attached],
        },
      });
      assert.equal(await recordDemo(demo), null);
      assert.deepEqual(steps(bridge.requests), [
        "run-turn attempt-1",
        "attach-asset attempt-1",
      ]);
    },
  },
  {
    name: "CLV-315 each failed demo turn gives its failure text to the second turn",
    run: async () => {
      for (const [result, text] of failures) {
        using bridge = fakeStepBridge({
          effects: {
            "claude run-turn": [result, recorded],
            "github attach-asset": [attached],
          },
        });
        assert.equal(await recordDemo(demo), null);
        assert.deepEqual(steps(bridge.requests), [
          "run-turn attempt-1",
          "run-turn attempt-2",
          "attach-asset attempt-2",
        ]);
        assert.ok(
          (payloads(bridge.requests)[1] ?? "").endsWith(
            `The earlier demo attempt failed:\n${text}`,
          ),
          text,
        );
      }
    },
  },
  {
    name: "CLV-315 two failures of a demo block the round with demo-failed",
    run: async () => {
      const cases = [
        { turns: [recorded], uploads: [uploadFailed, uploadFailed] },
        { turns: [completed(null), completed(null)], uploads: [] },
        { turns: [completed(null), recorded], uploads: [uploadFailed] },
      ];
      for (const { turns, uploads } of cases) {
        using bridge = fakeStepBridge({
          effects: {
            "claude run-turn": turns,
            "github attach-asset": uploads,
          },
        });
        assert.deepEqual(await recordDemo(demo), blocked);
        assert.equal(bridge.requests.length, turns.length + uploads.length);
      }
    },
  },
  {
    name: "CLV-315 a failed upload of a recorded demo uploads the same video again",
    run: async () => {
      using bridge = fakeStepBridge({
        effects: {
          "claude run-turn": [recorded],
          "github attach-asset": [uploadFailed, attached],
        },
      });
      assert.equal(await recordDemo(demo), null);
      assert.deepEqual(steps(bridge.requests), [
        "run-turn attempt-1",
        "attach-asset attempt-1",
        "attach-asset attempt-2",
      ]);
      const [first, second] = payloads(bridge.requests).slice(1);
      assert.equal(first, second);
    },
  },
];
