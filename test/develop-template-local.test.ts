import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runScenario } from "../src/testing.ts";
import { completed, commit } from "./develop-template-flow-fixture.ts";

const workflow = fileURLToPath(
  new URL("../templates/develop/develop/local.ts", import.meta.url),
);
const state = {
  input: {
    cycleId: "run-1",
    repository: "main-checkout",
    ticket: "Implement the task.",
    issue: null,
  },
  round: 1,
  feedback: null,
};

await test("CLV-221 local review refuses missing, malformed and dirty commit snapshots before approval", async () => {
  for (const snapshot of [
    {},
    { commit: "short" },
    { commit, uncommitted: null },
    { commit, uncommitted: [" M counter.ts"] },
  ])
    await assert.rejects(
      runScenario({
        workflow,
        exportName: "localRound",
        input: state,
        effects: {
          "claude run-turn": [
            completed({
              summary: "Done.\nTicket status: complete",
              uncommitted: [],
              ...snapshot,
            }),
          ],
        },
        decisions: [{ decision: "approved", answer: null }],
      }),
      /invalid-local-commit/,
    );
});

await test("CLV-221 local approval leaves the accepted commit for a person to merge", async () => {
  const result = await runScenario({
    workflow,
    exportName: "localRound",
    input: state,
    effects: {
      "claude run-turn": [
        completed({
          summary: "Done.\nTicket status: complete",
          commit,
          uncommitted: [],
        }),
      ],
    },
    decisions: [{ decision: "approved", answer: null }],
  });
  assert.deepEqual(result.outcome, {
    kind: "handoff_requested",
    cycleId: "run-1",
    promotionId: `local-${commit}`,
    ticketStatus: "complete",
  });
  assert.deepEqual(
    result.requests.map((request) => request[0]),
    ["effect", "waitForDecision"],
  );
});

await test("CLV-221 local denial preserves feedback and stops without feedback or after three fixes", async () => {
  for (const [round, answer] of [
    [1, "Add the missing test."],
    [1, null],
    [4, "One more fix."],
  ] as const) {
    const result = await runScenario({
      workflow,
      exportName: "localRound",
      input: { ...state, round },
      effects: {
        "claude run-turn": [
          completed({
            summary: "Done.\nTicket status: complete",
            commit,
            uncommitted: [],
          }),
        ],
      },
      decisions: [{ decision: "denied", answer }],
    });
    assert.deepEqual(
      result.outcome,
      round === 1 && answer !== null
        ? { reason: "review-changes", output: answer, remaining: [] }
        : {
            kind: "blocked",
            cycleId: "run-1",
            reason: "review-changes",
            evidenceId: "review",
          },
    );
    assert.equal(result.requests.length, 2);
  }
});

await test("CLV-221 a partial local report requires an explicit bounded continuation before approval", async () => {
  for (const [round, answer] of [
    [1, "Finish recovery."],
    [1, null],
    [4, "Finish recovery."],
  ] as const) {
    const result = await runScenario({
      workflow,
      exportName: "localRound",
      input: { ...state, round },
      effects: {
        "claude run-turn": [
          completed({
            summary: "Remaining:\n- Recovery.\nTicket status: partial",
          }),
        ],
      },
      decisions: [{ decision: "answered", answer }],
    });
    assert.deepEqual(
      result.outcome,
      round === 1 && answer !== null
        ? { reason: "partial-work", output: answer, remaining: ["Recovery."] }
        : {
            kind: "blocked",
            cycleId: "run-1",
            reason: "partial-work",
            evidenceId: `partial:run-1:${String(round)}`,
          },
    );
    assert.equal(result.requests.length, round === 4 ? 1 : 2);
  }
});

await test("CLV-221 the input adapters require their declared input form", async () => {
  const workflow = fileURLToPath(
    new URL("../templates/develop/develop/report.ts", import.meta.url),
  );
  const common = { cycleId: "run-1", repository: "main-checkout" };
  for (const [exportName, input] of [
    ["ticketInput", { ticket: { id: "42", text: "Ticket text." } }],
    ["promptInput", { prompt: "Task text." }],
  ] as const) {
    const result = await runScenario({
      workflow,
      exportName,
      input: { ...common, input },
    });
    assert.deepEqual(result.outcome, {
      ...common,
      ticket: "ticket" in input ? input.ticket.text : input.prompt,
      issue: null,
    });
    await assert.rejects(
      runScenario({ workflow, exportName, input: { ...common, input: {} } }),
      /input-required/,
    );
  }
});
