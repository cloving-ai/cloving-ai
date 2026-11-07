import assert from "node:assert/strict";
import { fakeStepBridge } from "cloving/workflows/testing";
import { develop } from "../develop.ts";
import { completed, input, selection } from "./scenarios.ts";
import {
  approved,
  callName,
  completeCalls,
  requestInput,
  panelEffects,
  scenarioEffects,
} from "./option-tests.ts";

export const recoveryOptionTests =
  selection.merge === "local" ? [] : [shortFailureTest(), roundLimitTest()];

function shortFailureTest() {
  return {
    name: "CLV-300 the selected recovery retries a short open-pr failure or fails the run",
    run: async () => {
      const scenario = scenarioEffects();
      using bridge = fakeStepBridge({
        effects: {
          ...scenario,
          "github open-pr": [
            {
              kind: "failed",
              operationId: "open",
              reason: "git-call-failed",
            },
            ...scenario["github open-pr"],
          ],
        },
        decisions: [approved, approved],
      });
      const stopped = selection.recovery === "stop";
      const ended = await develop(requestInput()).then(
        (outcome) => outcome.kind,
        (error: unknown) => String(Reflect.get(Object(error), "message")),
      );
      assert.equal(ended, stopped ? "git-call-failed" : "handoff_requested");
      const complete = completeCalls();
      const opened = complete.indexOf("open-pr") + 1;
      const expected = stopped
        ? complete
            .slice(0, opened)
            .concat(selection.input === "ticket" ? ["label"] : [])
        : complete
            .slice(0, opened)
            .concat(["sleep", "open-pr"], complete.slice(opened));
      assert.deepEqual(bridge.requests.map(callName), expected);
    },
  };
}

function roundLimitTest() {
  return {
    name: "CLV-300 the selected recovery asks at the round limit or blocks as before",
    run: async () => {
      using bridge = fakeStepBridge({
        effects: limitEffects(),
        decisions: limitDecisions(),
      });
      const outcome = await develop(requestInput());
      const asked = bridge.requests.flatMap((request) =>
        request[0] === "waitForDecision" &&
        request[1].gateId.startsWith("recovery:")
          ? [request[1].gateId]
          : [],
      );
      const stopped = selection.recovery === "stop";
      assert.deepEqual(outcome, {
        kind: "blocked",
        cycleId: input.cycleId,
        reason: stopped ? "check-failed" : "check-failed: pull/7",
        evidenceId: "merge",
      });
      assert.deepEqual(asked, stopped ? [] : [`recovery:${input.cycleId}:4`]);
    },
  };
}

function limitEffects() {
  const scenario = scenarioEffects();
  const four = (list: readonly ReturnType<typeof completed>[]) =>
    Array.from({ length: 4 }, () => list[0] ?? completed(null));
  return {
    ...scenario,
    "claude run-turn": four(scenario["claude run-turn"]),
    "claude run-turn:review": four(scenario["claude run-turn:review"]),
    ...panelEffects(4),
    "github open-pr": four(scenario["github open-pr"]),
    "github wait-review": four(scenario["github wait-review"]),
    "command run:red-green": four(scenario["command run:red-green"]),
    "github merge": four([
      completed({ reason: "check-failed", output: "Check output." }),
    ]),
  };
}

function limitDecisions() {
  const round = [
    ...(selection.accept === "person" ? [approved] : []),
    ...(selection.merge === "person" ? [approved] : []),
  ];
  return [
    ...round,
    ...round,
    ...round,
    ...round,
    { decision: "answered" as const, answer: "2" },
  ];
}
