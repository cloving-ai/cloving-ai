import assert from "node:assert/strict";
import { test } from "node:test";
import { field, ran, request } from "./develop-workflow-fixture.ts";

const input = {
  cycleId: "clv-016-a6f7ef47",
  ticketId: "CLV-016",
  ticket: "# CLV-016: Connect the board",
  repository: "/repositories/cloving",
};
const decision = { gateId: "review-1", decision: "approved", answer: null };
const turnResult = JSON.stringify({
  summary: "I added the board client.",
  branch: "cloving/clv-016-a6f7ef47",
  commits: ["1a2b3c4 Add the board client", "5d6e7f8 Test the board client"],
  files: [" src/board.ts | 40 +"],
  uncommitted: [],
  worktree: "/host/worktrees/clv-016-a6f7ef47",
  costUsd: 1.0330776000000002,
});
const completed = {
  kind: "completed",
  operationId: "operation-1",
  receipt: "turn-1",
  result: turnResult,
};
const opened = { kind: "opened", decisionId: "review-1" };
const reviewText = [
  "Review the work of the Claude worker for the ticket CLV-016.",
  "Round: 1 of 3",
  "Branch: cloving/clv-016-a6f7ef47",
  "Work tree: /host/worktrees/clv-016-a6f7ef47",
  "Cost (USD): 1.03",
  "",
  "Commits:",
  "1a2b3c4 Add the board client",
  "5d6e7f8 Test the board client",
  "",
  "Changed files:",
  " src/board.ts | 40 +",
  "",
  "Not committed:",
  "",
  "",
  "Report of the worker:",
  "I added the board client.",
  "",
  "Approve to accept the branch, then merge the branch yourself.",
  "Deny with a feedback text to send the work back to the worker for one more round. Deny with no text to reject the work.",
].join("\n");

await test("CLV-016 the ticket workflow asks the Claude worker for one turn with the ticket text and the work tree instructions, then opens one approval with the result of the turn, and waits for the decision", async () => {
  const [first] = await ran([{ input, turn: completed, gate: opened }]);
  assert.deepEqual(field(first, "outcome"), {
    kind: "waiting_for_decision",
    cycleId: "clv-016-a6f7ef47",
    decisionId: "review-1",
  });
  const effect = request(first, 0);
  const payload = String(field(effect, "payload"));
  assert.deepEqual(
    { ...Object(effect), payload: "" },
    {
      scope: { phase: "implement", operation: "claude-turn", round: 1 },
      capability: "claude",
      method: "run-turn",
      target: "clv-016-a6f7ef47",
      payload: "",
      units: 1,
    },
  );
  assert.match(payload, /^You work on one ticket of this repository\./);
  assert.match(payload, /The main repository is at \/repositories\/cloving\./);
  assert.match(
    payload,
    /cp -c -R \/repositories\/cloving\/node_modules node_modules/,
  );
  assert.match(
    payload,
    /Treat a check time warning as work to do in the same ticket when your change made the check slower\./,
  );
  assert.match(
    payload,
    /Run the checks of the repository before you finish\. Commit your work before the report\. If the repository provides npm run check:clean, run it after committing\./,
  );
  assert.match(
    payload,
    /\n\nThe text of the ticket CLV-016:\n\n# CLV-016: Connect the board$/,
  );
  assert.deepEqual(request(first, 1), {
    gateId: "review-1",
    kind: "approval",
    prompt: reviewText,
  });
});

await test("CLV-016 the ticket workflow ends with a handoff after an approval and as blocked after a denial, and a continuation asks for no turn", async () => {
  const [approved, denied] = await ran([
    { input, decision },
    { input, decision: { ...decision, decision: "denied" } },
  ]);
  assert.deepEqual(approved, {
    outcome: {
      kind: "handoff_requested",
      cycleId: "clv-016-a6f7ef47",
      promotionId: "cloving-clv-016-a6f7ef47",
    },
    requests: [],
  });
  assert.deepEqual(denied, {
    outcome: {
      kind: "blocked",
      cycleId: "clv-016-a6f7ef47",
      reason: "The operator denied the work.",
      evidenceId: "review-1",
    },
    requests: [],
  });
});

await test("CLV-016 the ticket workflow ends as blocked when the turn gives no result or the gate does not open, and a run with no ticket ID and a result with no text has plain words", async () => {
  const stopped = { kind: "stopped", operationId: "operation-1", reason: null };
  const refused = { kind: "refused", reason: "run-not-running" };
  const unnamed = { ...input, ticketId: undefined };
  const [noTurn, noGate, plain] = await ran([
    { input, turn: stopped, gate: opened },
    { input, turn: completed, gate: refused },
    { input: unnamed, turn: { ...completed, result: null }, gate: opened },
  ]);
  assert.deepEqual(field(noTurn, "outcome"), {
    kind: "blocked",
    cycleId: "clv-016-a6f7ef47",
    reason: "The Claude turn has the result stopped.",
    evidenceId: "claude-turn",
  });
  assert.equal(field(field(noTurn, "requests"), "length"), 1);
  assert.deepEqual(field(noGate, "outcome"), {
    kind: "blocked",
    cycleId: "clv-016-a6f7ef47",
    reason: "The review gate has the result refused.",
    evidenceId: "review-1",
  });
  assert.match(
    String(field(request(plain, 0), "payload")),
    /\n\nThe text of this ticket:\n\n/,
  );
  assert.match(
    String(field(request(plain, 1), "prompt")),
    /^Review the work of the Claude worker for this ticket\.\nRound: 1 of 3\nBranch: \nWork tree: \n/,
  );
});

const feedback = "Add a test for an empty list.";
const denial = (gateId: string, answer: string | null): unknown => ({
  gateId,
  decision: "denied",
  answer,
});

await test("CLV-062 a denial with a feedback text starts the next round on the same target with the ticket text and the feedback, then opens the next review", async () => {
  const [second] = await ran([
    {
      input,
      decision: denial("review-1", feedback),
      turn: completed,
      gate: { kind: "opened", decisionId: "review-2" },
    },
  ]);
  assert.deepEqual(field(second, "outcome"), {
    kind: "waiting_for_decision",
    cycleId: "clv-016-a6f7ef47",
    decisionId: "review-2",
  });
  const effect = request(second, 0);
  assert.deepEqual(
    { ...Object(effect), payload: "" },
    {
      scope: { phase: "implement", operation: "claude-turn", round: 2 },
      capability: "claude",
      method: "run-turn",
      target: "clv-016-a6f7ef47",
      payload: "",
      units: 1,
    },
  );
  const payload = String(field(effect, "payload"));
  assert.match(payload, /^You work on one ticket of this repository\./);
  assert.match(
    payload,
    /\n\nThe text of the ticket CLV-016:\n\n# CLV-016: Connect the board\n\n/,
  );
  assert.match(
    payload,
    /\n\nThis is round 2\. The branch has the commits of the earlier rounds\. The operator denied the work of round 1 with this feedback:\n\nAdd a test for an empty list\.$/,
  );
  const gate = request(second, 1);
  assert.equal(field(gate, "gateId"), "review-2");
  assert.equal(field(gate, "kind"), "approval");
  assert.match(
    String(field(gate, "prompt")),
    /^Review the work of the Claude worker for the ticket CLV-016\.\nRound: 2 of 3\n/,
  );
});

await test("CLV-062 a denial of review 2 with a feedback text starts round 3, and its review says that it is the last round", async () => {
  const [third] = await ran([
    {
      input,
      decision: denial("review-2", "Name the empty case."),
      turn: completed,
      gate: { kind: "opened", decisionId: "review-3" },
    },
  ]);
  assert.deepEqual(field(request(third, 0), "scope"), {
    phase: "implement",
    operation: "claude-turn",
    round: 3,
  });
  assert.match(
    String(field(request(third, 0), "payload")),
    /The operator denied the work of round 2 with this feedback:\n\nName the empty case\.$/,
  );
  assert.equal(field(request(third, 1), "gateId"), "review-3");
  assert.match(
    String(field(request(third, 1), "prompt")),
    /\nDeny to reject the work\. This is the last round\.$/,
  );
});

await test("CLV-062 an approval of a later review ends with a handoff, and a denial with no text or a denial in round 3 ends as blocked with the cause", async () => {
  const [approved, silent, last] = await ran([
    { input, decision: { ...decision, gateId: "review-2" } },
    { input, decision: denial("review-2", null) },
    { input, decision: denial("review-3", feedback) },
  ]);
  assert.deepEqual(approved, {
    outcome: {
      kind: "handoff_requested",
      cycleId: "clv-016-a6f7ef47",
      promotionId: "cloving-clv-016-a6f7ef47",
    },
    requests: [],
  });
  assert.deepEqual(silent, {
    outcome: {
      kind: "blocked",
      cycleId: "clv-016-a6f7ef47",
      reason: "The operator denied the work.",
      evidenceId: "review-2",
    },
    requests: [],
  });
  assert.deepEqual(last, {
    outcome: {
      kind: "blocked",
      cycleId: "clv-016-a6f7ef47",
      reason:
        "The operator denied the work of round 3, and a run has at most 3 rounds.",
      evidenceId: "review-3",
    },
    requests: [],
  });
});
