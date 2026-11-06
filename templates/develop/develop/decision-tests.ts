import assert from "node:assert/strict";
import { fakeStepBridge } from "cloving/workflows/testing";
import { develop } from "../develop.ts";
import { commit, completed, effects, input } from "./scenarios.ts";
import type { FlowTest } from "./flow-tests.ts";
import { recover } from "./recovery.ts";
import { ticketInput } from "./report.ts";
import {
  answered,
  calls,
  checkFailed,
  conflict,
  conflictOutput,
  failingRounds,
  failure,
  questions,
} from "./recovery-scenarios.ts";

export const decisionTests: FlowTest[] = [];

decisionTests.push({
  name: "CLV-300 at the round limit a person chooses two more rounds",
  run: async () => {
    using bridge = fakeStepBridge({
      effects: failingRounds([
        ...Array.from({ length: 4 }, () => checkFailed),
        ...effects()["github merge"],
      ]),
      decisions: [answered("1")],
    });
    assert.equal((await develop(input)).kind, "handoff_requested");
    const turns = bridge.requests.flatMap((request) =>
      request[0] === "effect" && request[1].method === "run-turn"
        ? [request[1]]
        : [],
    );
    assert.deepEqual(
      turns.map((turn) => turn.scope.round),
      [1, 2, 3, 4, 5],
    );
    assert.match(
      turns[4]?.payload ?? "",
      /This is fix round 5\. Address check-failed/,
    );
    const [question] = questions(bridge.requests);
    assert.ok(question);
    assert.equal(question.kind, "question");
    assert.equal(question.gateId, "recovery:run-1:4");
    for (const text of [
      "pull/7",
      "check-failed",
      "Check output.",
      "1. Two more rounds",
      "2. Stop and keep the pull request open",
      "3. Close the pull request",
    ])
      assert.ok(question.prompt.includes(text), text);
    assert.equal(questions(bridge.requests).length, 1);
  },
});

decisionTests.push({
  name: "CLV-300 at the round limit a person stops and keeps the pull request open",
  run: async () => {
    using bridge = fakeStepBridge({
      effects: failingRounds(Array.from({ length: 4 }, () => checkFailed)),
      decisions: [answered("Stop and keep the pull request open")],
    });
    assert.deepEqual(await develop(input), {
      kind: "blocked",
      cycleId: input.cycleId,
      reason: "check-failed: pull/7",
      evidenceId: "merge",
    });
    const names = calls(bridge.requests);
    assert.deepEqual(names.slice(-2), ["waitForDecision", "label"]);
    assert.ok(!names.includes("close-pr"));
  },
});

decisionTests.push({
  name: "CLV-300 the decision after round six offers only the two stop options",
  run: async () => {
    using bridge = fakeStepBridge({
      effects: failingRounds(Array.from({ length: 6 }, () => checkFailed)),
      decisions: [answered("1"), answered("1")],
    });
    assert.deepEqual(await develop(input), {
      kind: "blocked",
      cycleId: input.cycleId,
      reason: "check-failed: pull/7",
      evidenceId: "merge",
    });
    const asked = questions(bridge.requests);
    assert.deepEqual(
      asked.map((question) => question.gateId),
      ["recovery:run-1:4", "recovery:run-1:6"],
    );
    assert.ok(!asked[1]?.prompt.includes("Two more rounds"));
    assert.match(asked[1]?.prompt ?? "", /\n2\. Stop.*\n3\. Close/s);
    assert.equal(
      calls(bridge.requests).filter((name) => name === "run-turn").length,
      6,
    );
  },
});

decisionTests.push({
  name: "CLV-300 at the round limit a person closes the pull request",
  run: async () => {
    using bridge = fakeStepBridge({
      effects: {
        ...failingRounds(Array.from({ length: 4 }, () => checkFailed)),
        "github close-pr": [completed({ number: 7, closed: true })],
      },
      decisions: [answered("3")],
    });
    assert.deepEqual(await develop(input), {
      kind: "blocked",
      cycleId: input.cycleId,
      reason: "pull-request-closed: pull/7",
      evidenceId: "merge",
    });
    const closed = bridge.requests.find(
      (request) => request[0] === "effect" && request[1].method === "close-pr",
    );
    assert.ok(closed && closed[0] === "effect");
    assert.deepEqual(closed[1].scope, {
      phase: "pull-request",
      operation: "github-close-pr",
      round: 4,
    });
    assert.equal(closed[1].target, input.cycleId);
    assert.deepEqual(JSON.parse(closed[1].payload), { number: 7 });
    assert.deepEqual(calls(bridge.requests).slice(-3), [
      "waitForDecision",
      "close-pr",
      "label",
    ]);
  },
});

decisionTests.push({
  name: "CLV-300 a failed close keeps the run blocked with the reason and the link",
  run: async () => {
    using bridge = fakeStepBridge({
      effects: {
        ...failingRounds(Array.from({ length: 4 }, () => checkFailed)),
        "github close-pr": [failure("github-call-failed")],
      },
      decisions: [answered("Close the pull request")],
    });
    assert.deepEqual(await develop(input), {
      kind: "blocked",
      cycleId: input.cycleId,
      reason: "github-call-failed: pull/7",
      evidenceId: "merge",
    });
    assert.equal(bridge.requests.at(-1)?.[0], "effect");
  },
});

decisionTests.push({
  name: "CLV-300 a denied, expired or unknown recovery answer stops with the pull request open",
  run: async () => {
    for (const decision of [
      { decision: "denied" as const, answer: "1" },
      { decision: "expired" as const, answer: null },
      { decision: "approved" as const, answer: null },
      answered(" \n"),
      answered("4"),
      answered("Two more rounds, please"),
    ]) {
      using bridge = fakeStepBridge({
        effects: failingRounds(Array.from({ length: 4 }, () => checkFailed)),
        decisions: [decision],
      });
      assert.deepEqual(await develop(input), {
        kind: "blocked",
        cycleId: input.cycleId,
        reason: "check-failed: pull/7",
        evidenceId: "merge",
      });
      assert.equal(questions(bridge.requests).length, 1);
    }
  },
});

decisionTests.push({
  name: "CLV-300 a second merge conflict starts a repair turn that names the conflicting files",
  run: async () => {
    using bridge = fakeStepBridge({
      effects: failingRounds([
        conflict,
        conflict,
        ...effects()["github merge"],
      ]),
    });
    assert.equal((await develop(input)).kind, "handoff_requested");
    const turns = bridge.requests.flatMap((request) =>
      request[0] === "effect" && request[1].method === "run-turn"
        ? [request[1].payload]
        : [],
    );
    assert.equal(turns.length, 3);
    assert.ok(!(turns[1] ?? "").includes("Conflicting files:"));
    const prompt = turns[2] ?? "";
    assert.match(prompt, /This is fix round 3\. Address merge-conflict/);
    assert.ok(
      prompt.includes("Conflicting files:\n- src/counter.ts\n- src/old.ts\n"),
      prompt,
    );
    for (const text of [
      `- This branch: the commits of pull request #7 up to ${commit}.`,
      "- The base branch:",
      "- Git: modify/delete: src/old.ts deleted in origin/main and modified in HEAD.",
    ])
      assert.ok(prompt.includes(text), text);
    assert.ok(prompt.endsWith(conflictOutput));
  },
});

decisionTests.push({
  name: "CLV-300 a third merge conflict opens the decision before the round limit",
  run: async () => {
    using bridge = fakeStepBridge({
      effects: failingRounds([conflict, conflict, conflict]),
      decisions: [answered("2")],
    });
    assert.deepEqual(await develop(input), {
      kind: "blocked",
      cycleId: input.cycleId,
      reason: "merge-conflict: pull/7",
      evidenceId: "merge",
    });
    const [question] = questions(bridge.requests);
    assert.ok(question);
    assert.equal(question.gateId, "recovery:run-1:3");
    assert.ok(question.prompt.includes("Conflicting files:"));
    assert.equal(
      calls(bridge.requests).filter((name) => name === "run-turn").length,
      3,
    );
  },
});

decisionTests.push({
  name: "CLV-300 two more rounds after round five still asks at round six",
  run: async () => {
    using bridge = fakeStepBridge({
      effects: failingRounds([
        checkFailed,
        checkFailed,
        conflict,
        conflict,
        conflict,
        checkFailed,
      ]),
      decisions: [answered("1"), answered("1"), answered("2")],
    });
    assert.deepEqual(await develop(input), {
      kind: "blocked",
      cycleId: input.cycleId,
      reason: "check-failed: pull/7",
      evidenceId: "merge",
    });
    assert.deepEqual(
      questions(bridge.requests).map((question) => question.gateId),
      ["recovery:run-1:4", "recovery:run-1:5", "recovery:run-1:6"],
    );
  },
});

decisionTests.push({
  name: "CLV-300 a review that does not accept and gives no findings asks a person",
  run: async () => {
    const scenario = failingRounds([
      checkFailed,
      checkFailed,
      checkFailed,
      ...effects()["github merge"],
    ]);
    scenario["github wait-review"] = [
      completed({ number: 7, commit, score: 4, summary: "", findings: [] }),
      ...scenario["github wait-review"].slice(1),
    ];
    scenario["github merge"] = scenario["github merge"].slice(1);
    using bridge = fakeStepBridge({
      effects: scenario,
      decisions: [answered("1")],
    });
    assert.equal((await develop(input)).kind, "handoff_requested");
    assert.deepEqual(
      questions(bridge.requests).map((question) => question.gateId),
      ["recovery:run-1:1"],
    );
    const turns = bridge.requests.flatMap((request) =>
      request[0] === "effect" && request[1].method === "run-turn"
        ? [request[1].scope.round]
        : [],
    );
    assert.deepEqual(turns, [1, 2, 3, 4]);
  },
});

decisionTests.push({
  name: "CLV-300 a merge denial without an answer stops without a recovery question",
  run: async () => {
    using bridge = fakeStepBridge({});
    const report = {
      summary: "Done.",
      status: { kind: "complete" as const },
      commit,
      clean: true,
    };
    assert.deepEqual(
      await recover({
        state: { input: ticketInput(input), round: 1, feedback: null },
        report,
        pull: { number: 7, url: "pull/7", commit, target: input.cycleId },
        result: { reason: "not-approved", output: "" },
      }),
      {
        kind: "blocked",
        cycleId: input.cycleId,
        reason: "not-approved",
        evidenceId: "merge",
      },
    );
    assert.deepEqual(bridge.requests, []);
  },
});
