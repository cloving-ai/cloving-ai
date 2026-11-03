import assert from "node:assert/strict";
import {
  fakeStepBridge,
  type ScenarioRequest,
} from "cloving/workflows/testing";
import { develop } from "../develop.ts";
import {
  approved,
  callName,
  completeCalls,
  requestInput,
  scenarioEffects,
} from "./option-tests.ts";
import { developReport, ticketInput } from "./report.ts";
import { completed, input } from "./scenarios.ts";

const interrupted = {
  kind: "failed" as const,
  operationId: "interrupted-turn",
  reason: "claude-turn-interrupted",
};

function turns(requests: readonly ScenarioRequest[]) {
  return requests.flatMap((request) =>
    request[0] === "effect" && request[1].method === "run-turn"
      ? [request[1]]
      : [],
  );
}

export const interruptionTests = [
  {
    name: "CLV-272 an interrupted turn runs again once in the same work tree",
    run: async () => {
      const scenario = scenarioEffects();
      using bridge = fakeStepBridge({
        effects: {
          ...scenario,
          "claude run-turn": [interrupted, ...scenario["claude run-turn"]],
        },
        decisions: [approved, approved],
      });
      assert.equal((await develop(requestInput())).kind, "handoff_requested");
      const expected = completeCalls();
      expected.splice(expected.indexOf("run-turn"), 0, "run-turn");
      assert.deepEqual(bridge.requests.map(callName), expected);
      const [first, second] = turns(bridge.requests);
      assert.ok(first && second);
      assert.deepEqual(first.scope, {
        phase: "implement",
        operation: "claude-turn",
        round: 1,
      });
      assert.ok(!first.payload.includes("stopped before its report"));
      assert.deepEqual(second.scope, {
        phase: "implement",
        operation: "claude-turn",
        round: 1,
        key: "continuation",
      });
      assert.equal(second.target, first.target);
      assert.ok(second.payload.endsWith(first.payload));
      for (const sentence of [
        "The earlier turn of round 1 stopped before its report.",
        "The work tree holds the work of that turn.",
        "Before you continue, check the work tree, the commits since the start of the round, and the ticket.",
      ])
        assert.ok(second.payload.includes(sentence), sentence);
    },
  },
  {
    name: "CLV-272 a second interruption of the same turn blocks the run",
    run: async () => {
      using bridge = fakeStepBridge({
        effects: {
          ...scenarioEffects(),
          "claude run-turn": [interrupted, interrupted],
        },
      });
      assert.deepEqual(await develop(requestInput()), {
        kind: "blocked",
        cycleId: requestInput().cycleId,
        reason: "turn-interrupted",
        evidenceId: "implement",
      });
      assert.deepEqual(bridge.requests.map(callName), stoppedCalls());
      const labels = bridge.requests.flatMap((request) =>
        request[0] === "effect" && request[1].method === "label"
          ? [request[1].payload]
          : [],
      );
      for (const payload of labels.slice(1))
        assert.match(payload, /"add":\["cloving: blocked"\]/);
    },
  },
  {
    name: "CLV-272 an interrupted fix turn continues with its round and feedback",
    run: async () => {
      using bridge = fakeStepBridge({
        effects: {
          "claude run-turn": [
            interrupted,
            completed({ summary: "Fixed.\nTicket status: complete" }),
          ],
        },
      });
      const output = "Check output.\n";
      const report = await developReport({
        input: ticketInput(input),
        round: 2,
        feedback: { reason: "check-failed", output, remaining: ["Add it."] },
      });
      assert.ok(!("kind" in report));
      assert.equal(report.summary, "Fixed.\nTicket status: complete");
      const [first, second] = turns(bridge.requests);
      assert.ok(first && second);
      assert.equal(first.scope.round, 2);
      assert.equal(second.scope.round, 2);
      assert.equal(second.scope.key, "continuation");
      assert.ok(
        second.payload.startsWith(
          "The earlier turn of round 2 stopped before its report.",
        ),
      );
      assert.ok(second.payload.endsWith(first.payload));
      assert.ok(second.payload.endsWith(output));
      assert.match(
        second.payload,
        /This is fix round 2\. Address check-failed/,
      );
    },
  },
  ...[
    { kind: "failed" as const, operationId: "turn", reason: "worker-failed" },
    { kind: "refused" as const, reason: "budget-exhausted" },
  ].map((failure) => ({
    name: `CLV-272 a ${failure.reason} continuation fails the run`,
    run: async () => {
      using bridge = fakeStepBridge({
        effects: {
          ...scenarioEffects(),
          "claude run-turn": [interrupted, failure],
        },
      });
      await assert.rejects(develop(requestInput()), {
        message: failure.reason,
      });
      assert.deepEqual(bridge.requests.map(callName), stoppedCalls());
    },
  })),
];

function stoppedCalls(): string[] {
  const complete = completeCalls();
  const started = complete.slice(0, complete.indexOf("run-turn") + 1);
  return started.concat("run-turn", started.includes("label") ? ["label"] : []);
}
