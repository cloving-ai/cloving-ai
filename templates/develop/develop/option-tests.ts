import assert from "node:assert/strict";
import {
  fakeStepBridge,
  type ScenarioRequest,
} from "cloving/workflows/testing";
import { develop } from "../develop.ts";
import { commit, input, completed, effects, selection } from "./scenarios.ts";

const taskText =
  "Develop the submitted task text.\n\nGitHub issue: acme/demo#42 (open)";

function requestInput() {
  return selection.input === "ticket"
    ? input
    : {
        cycleId: input.cycleId,
        repository: input.repository,
        input: { prompt: taskText },
      };
}

function scenarioEffects() {
  return {
    ...effects(),
    "claude run-turn": [
      completed({
        summary: "Done.\nTicket status: complete",
        commit,
        uncommitted: [],
      }),
    ],
    "claude run-turn:review": [
      completed({ summary: "Reviewed.", reviewVerdict: "accept" }),
    ],
    "github partial-issue": [completed({ ticketStatus: "partial" })],
  };
}

function completeCalls(): string[] {
  const review: Readonly<Record<string, string>> = {
    greptile: "wait-review",
    person: "approval",
    turn: "run-turn:review",
  };
  const acceptance = ["run-turn", review[selection.accept] ?? "unknown-review"];
  if (selection.merge === "local") return acceptance;
  return ["prepare"].concat(
    selection.input === "ticket" ? ["label"] : [],
    ["run-turn", "open-pr", review[selection.accept] ?? "unknown-review"],
    selection.merge === "person" ? ["approval", "merge"] : ["merge"],
    selection.input === "ticket" ? ["close-issue"] : [],
  );
}

const approved = { decision: "approved" as const, answer: null };

function callName(request: ScenarioRequest): string {
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
        effectLimit: 27,
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
      assert.equal(turns.length, 1);
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
          ? [partial]
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
          request[0] === "effect" && request[1].method === "run-turn",
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
];
