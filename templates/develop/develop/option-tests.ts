import assert from "node:assert/strict";
import {
  fakeStepBridge,
  type ScenarioRequest,
} from "cloving/workflows/testing";
import { develop } from "../develop.ts";
import {
  commit,
  input,
  completed,
  effects,
  selection,
  repairVerdicts,
  verificationEffects,
} from "./scenarios.ts";

const taskText =
  "Develop the submitted task text.\n\nGitHub issue: acme/demo#42 (open)";

export function requestInput() {
  return selection.input === "ticket"
    ? input
    : {
        cycleId: input.cycleId,
        repository: input.repository,
        input: { prompt: taskText },
      };
}

export const demoTurns =
  selection.demo === "record"
    ? [completed({ summary: "Recorded.\nDemo status: recorded" })]
    : [];

export function scenarioEffects() {
  return {
    ...effects(),
    "claude run-turn": [
      completed({
        summary: "Done.\nTicket status: complete",
        commit,
        uncommitted: [],
      }),
    ].concat(demoTurns),
    "github attach-asset": [completed({ number: 7, url: "https://demo" })],
    "claude run-turn:review": [
      completed({ summary: "Reviewed.", reviewVerdict: "accept" }),
    ],
    ...panelEffects(1),
    "github partial-issue": [completed({ ticketStatus: "partial" })],
    "command run:red-green": [
      completed({ verdict: "accepted", output: "Passed." }),
    ],
  };
}

export const panelProfiles = [
  "review-claude",
  "review-codex",
  "review-gemini",
  "review-synthesis",
];

export function panelEffects(count: number) {
  return Object.fromEntries(
    panelProfiles.map((profile) => [
      `claude run-turn:${profile}`,
      Array.from({ length: count }, () =>
        completed({ summary: "Reviewed.", reviewVerdict: "accept" }),
      ),
    ]),
  );
}

const limits: Readonly<Record<string, number>> = {
  panel: 99,
  "red-green": 93,
  record: 99,
};

export const effectLimit =
  limits[selection.accept] ??
  limits[selection.verify] ??
  limits[selection.demo] ??
  87;

export function completeCalls(): string[] {
  const review: Readonly<Record<string, readonly string[]>> = {
    greptile: ["wait-review"],
    person: ["approval"],
    turn: ["run-turn:review"],
    panel: panelProfiles.map((profile) => `run-turn:${profile}`),
  };
  const reviews = review[selection.accept] ?? ["unknown-review"];
  const acceptance = ["run-turn"].concat(reviews);
  if (selection.merge === "local") return acceptance;
  return ["prepare"].concat(
    selection.input === "ticket" ? ["label"] : [],
    ["run-turn", "open-pr"],
    selection.verify === "red-green" ? ["run:red-green"] : [],
    reviews,
    selection.demo === "record" ? ["run-turn", "attach-asset"] : [],
    selection.merge === "person" ? ["approval", "merge"] : ["merge"],
    selection.input === "ticket" ? ["close-issue"] : [],
  );
}

export const approved = { decision: "approved" as const, answer: null };

export function callName(request: ScenarioRequest): string {
  if (request[0] === "effect") return request[1].method;
  if (request[0] === "waitForDecision") return request[1].kind;
  return request[0];
}

export const optionTests = [
  {
    name: "CLV-221 the selected complete configuration reviews and delivers its commit",
    run: async () => {
      using bridge = fakeStepBridge({
        effects: scenarioEffects(),
        decisions: [approved, approved],
        effectLimit,
      });
      assert.deepEqual(await develop(requestInput()), {
        kind: "handoff_requested",
        cycleId: input.cycleId,
        promotionId:
          selection.merge === "local" ? `local-${commit}` : "pull-request-7",
        ticketStatus: "complete",
      });
      assert.deepEqual(bridge.requests.map(callName), completeCalls());
      const gates = bridge.requests.filter(
        (request) => request[0] === "waitForDecision",
      );
      for (const gate of gates) assert.ok(gate[1].prompt.includes(commit));
      const turns = bridge.requests.filter(
        (request) =>
          request[0] === "effect" && request[1].method === "run-turn",
      );
      assert.equal(turns.length, 1 + demoTurns.length);
      assert.ok(
        turns.every(
          (turn) =>
            turn[0] === "effect" &&
            turn[1].payload.includes(
              selection.input === "ticket" ? input.input.ticket.text : taskText,
            ),
        ),
      );
      const merges = bridge.requests.filter(
        (request) => request[0] === "effect" && request[1].method === "merge",
      );
      assert.deepEqual(
        merges.map((request) =>
          request[0] === "effect" ? request[1].payload : null,
        ),
        selection.merge === "local"
          ? []
          : [JSON.stringify({ number: 7, commit, check: "beforeMerge" })],
      );
    },
  },
  {
    name: "CLV-221 the selected partial policy records work or asks for a bounded continuation",
    run: async () => {
      const scenario = scenarioEffects();
      const partial = completed({
        summary: "Remaining:\n- Add recovery.\nTicket status: partial",
        commit,
        uncommitted: [],
      });
      scenario["claude run-turn"] =
        selection.partial === "queue"
          ? [partial].concat(demoTurns)
          : [partial, ...scenario["claude run-turn"]];
      const decisions =
        selection.partial === "person"
          ? [
              {
                decision: "answered" as const,
                answer: "Preserve the result and add recovery.",
              },
              approved,
              approved,
            ]
          : [approved, approved];
      using bridge = fakeStepBridge({ effects: scenario, decisions });
      assert.equal((await develop(requestInput())).kind, "handoff_requested");
      const turns = bridge.requests.filter(
        (request) =>
          request[0] === "effect" && request[1].scope.phase === "implement",
      );
      assert.equal(turns.length, selection.partial === "queue" ? 1 : 2);
      assert.deepEqual(
        turns
          .slice(1)
          .map(
            (fix) =>
              fix[0] === "effect" &&
              fix[1].payload.endsWith(
                "Preserve the result and add recovery.",
              ) &&
              fix[1].payload.includes("- Add recovery."),
          ),
        selection.partial === "person" ? [true] : [],
      );
      const questions = bridge.requests.filter(
        (request) =>
          request[0] === "waitForDecision" && request[1].kind === "question",
      );
      assert.equal(questions.length, Number(selection.partial === "person"));
      assert.ok(
        questions.every(
          (request) =>
            request[0] === "waitForDecision" &&
            request[1].prompt.includes("- Add recovery."),
        ),
      );
      const updates = bridge.requests.filter(
        (request) =>
          request[0] === "effect" && request[1].method === "partial-issue",
      );
      assert.equal(updates.length, Number(selection.partial === "queue"));
    },
  },
].concat(
  selection.verify === "red-green" ? verificationTests() : [],
  selection.demo === "record" ? demoOptionTests() : [],
);

function demoOptionTests() {
  return [
    {
      name: "CLV-315 two failed demo attempts block the run before the merge",
      run: async () => {
        const failed = completed({ summary: "Demo status: failed" });
        const scenario = scenarioEffects();
        const developed = scenario["claude run-turn"].slice(0, 1);
        using bridge = fakeStepBridge({
          effects: {
            ...scenario,
            "claude run-turn": developed.concat([failed, failed]),
          },
          decisions: [approved, approved],
          effectLimit,
        });
        assert.deepEqual(await develop(requestInput()), {
          kind: "blocked",
          cycleId: input.cycleId,
          reason: "demo-failed",
          evidenceId: "demo",
        });
        const names = bridge.requests.map(callName);
        assert.ok(!names.includes("merge") && !names.includes("attach-asset"));
        assert.equal(names.filter((name) => name === "run-turn").length, 3);
      },
    },
  ];
}

function verificationTests() {
  return repairTests().concat(passingTests(), unavailableTests(), limitTests());
}

function repairTests() {
  return repairVerdicts.map((verdict) => ({
    name: `CLV-249 ${verdict} starts a fix turn with the full tool output`,
    run: async () => {
      using bridge = fakeStepBridge({
        effects: verificationEffects([verdict, "accepted"]),
        decisions: [approved, approved],
        effectLimit: 93,
      });
      assert.equal((await develop(requestInput())).kind, "handoff_requested");
      const expected = completeCalls();
      expected.splice(
        expected.indexOf("run:red-green") + 1,
        0,
        "run-turn",
        "open-pr",
        "run:red-green",
      );
      assert.deepEqual(bridge.requests.map(callName), expected);
      const fix = bridge.requests.find(
        (request) =>
          request[0] === "effect" &&
          request[1].method === "run-turn" &&
          request[1].scope.round === 2,
      );
      assert.ok(fix && fix[0] === "effect");
      assert.ok(fix[1].payload.includes(`Address ${verdict}`));
      assert.ok(fix[1].payload.endsWith(`${verdict}\nFull test output.`));
    },
  }));
}

function passingTests() {
  return ["accepted", "no-test-change"].map((verdict) => ({
    name: `CLV-249 ${verdict} continues to review and merge`,
    run: async () => {
      using bridge = fakeStepBridge({
        effects: verificationEffects([verdict]),
        decisions: [approved, approved],
      });
      assert.equal((await develop(requestInput())).kind, "handoff_requested");
      assert.deepEqual(bridge.requests.map(callName), completeCalls());
    },
  }));
}

function limitTests() {
  return [
    {
      name: "CLV-249 verification repairs stop after four development rounds",
      run: async () => {
        const stopped = selection.recovery === "stop";
        using bridge = fakeStepBridge({
          effects: verificationEffects(Array(4).fill("false-red")),
          decisions: stopped ? [] : [{ decision: "answered", answer: "2" }],
          effectLimit: 93,
        });
        assert.deepEqual(await develop(requestInput()), {
          kind: "blocked",
          cycleId: input.cycleId,
          reason: stopped ? "false-red" : "false-red: pull/7",
          evidenceId: "merge",
        });
        const names = bridge.requests.map(callName);
        assert.equal(names.filter((name) => name === "run-turn").length, 4);
        assert.equal(
          names.filter((name) => name === "run:red-green").length,
          4,
        );
        assert.ok(!names.includes("wait-review") && !names.includes("merge"));
      },
    },
  ];
}

function unavailableTests() {
  const unavailable = [
    completed({
      verdict: "prepare-failed",
      output: "Dependency preparation failed.",
    }),
    { kind: "failed" as const, operationId: "command", reason: "exit-1" },
    { kind: "unavailable" as const, reason: "cloving-host-unavailable" },
    { ...completed(null), result: "invalid JSON" },
    completed(null),
    completed({ verdict: "unknown", output: "Unknown verdict." }),
    completed({ verdict: "accepted" }),
    completed({ verdict: "false-red", output: 42 }),
  ];
  return unavailable.map((result, index) => ({
    name: `CLV-249 unavailable verification ${String(index)} blocks without a fix turn`,
    run: async () => {
      using bridge = fakeStepBridge({
        effects: {
          ...verificationEffects(["accepted"]),
          "command run:red-green": [result],
        },
      });
      assert.deepEqual(await develop(requestInput()), {
        kind: "blocked",
        cycleId: input.cycleId,
        reason: "red-green-unavailable",
        evidenceId: "red-green",
      });
      const complete = completeCalls();
      const expected = complete.slice(0, complete.indexOf("run:red-green") + 1);
      assert.deepEqual(
        bridge.requests.map(callName),
        expected.concat(selection.input === "ticket" ? ["label"] : []),
      );
    },
  }));
}
