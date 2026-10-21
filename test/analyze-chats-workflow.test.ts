import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { checkSubmission } from "../src/submission.ts";
import { isWorkflowDeclaration } from "../src/workflow-declaration.ts";
import { questionCandidate } from "./chats-analysis-fixture.ts";
import { importId } from "./chats-worker-fixture.ts";
import {
  input,
  snapshot,
  reply,
  completed,
  scenario,
  draftScenario,
  answeredScenario,
} from "./analyze-chats-workflow-fixture.ts";
import { field, ran, request } from "./develop-workflow-fixture.ts";

await test("CLV-116 accepted candidate uses one turn and three sequential charged effects with the captured snapshot", async () => {
  const [line] = await ran([scenario()]);
  assert.deepEqual(field(line, "outcome"), {
    kind: "handoff_requested",
    cycleId: input.cycleId,
    promotionId: `analysis:${importId}:${input.cycleId}`,
  });
  assert.deepEqual(
    [0, 1, 2].map((index) =>
      field(field(request(line, index), "scope"), "operation"),
    ),
    ["read-analysis", "turn-analysis", "save-analysis"],
  );
  assert.equal(field(line, "spent"), 3);
  assert.equal(field(field(line, "requests"), "length"), 3);
  assert.deepEqual(
    [0, 1, 2].map((index) => [
      field(request(line, index), "capability"),
      field(request(line, index), "method"),
      field(request(line, index), "units"),
    ]),
    [
      ["chats", "read-analysis", 1],
      ["claude", "run-turn:analyze-chats", 1],
      ["chats", "save-analysis", 1],
    ],
  );
  assert.deepEqual(JSON.parse(String(field(request(line, 0), "payload"))), {
    importId,
  });
  assert.deepEqual(JSON.parse(String(field(request(line, 1), "payload"))), {
    snapshot,
  });
  assert.deepEqual(JSON.parse(String(field(request(line, 2), "payload"))), {
    importId,
    cycleId: input.cycleId,
    snapshot,
    reply,
  });
  assert.equal(
    new Set(
      [0, 1, 2].map((index) =>
        JSON.stringify(field(request(line, index), "scope")),
      ),
    ).size,
    3,
  );
});

await test("CLV-149 submission declares exactly one required import ID and eleven effect units", () => {
  const declaration: unknown = JSON.parse(
    readFileSync(
      new URL("../workflows/analyze-chats.declaration.json", import.meta.url),
      "utf8",
    ),
  );
  assert.ok(isWorkflowDeclaration(declaration));
  assert.equal(declaration.workflowId, "analyze-chats");
  assert.equal(declaration.effectLimit, 11);
  assert.deepEqual(declaration.stages, [
    { name: "read-input", label: "Read input", operations: ["read-analysis"] },
    { name: "analyze", label: "Analyze", operations: ["turn-analysis"] },
    {
      name: "save-result",
      label: "Save result",
      operations: ["save-analysis"],
    },
  ]);
  assert.deepEqual(declaration.capabilities, ["chats", "claude"]);
  assert.deepEqual(declaration.input.fields, { importId: { type: "string" } });
  for (const submission of [
    {},
    { importId: "" },
    { importId: 1 },
    { importId, path: "evidence" },
    null,
  ]) {
    const result = checkSubmission(declaration.input, {
      workflowId: "analyze-chats",
      source: "input",
      submission,
    });
    assert.equal(result.kind, "rejected");
    assert.equal(field(result, "code"), "invalid-submission");
  }
  assert.equal(
    checkSubmission(declaration.input, {
      workflowId: "analyze-chats",
      source: "input",
      submission: { importId },
    }).kind,
    "valid",
  );
});

await test("CLV-116 every refusal blocks without a later effect or repair turn", async () => {
  const methods = [
    "chats read-analysis",
    "claude run-turn:analyze-chats",
    "chats save-analysis",
  ] as const;
  for (const [index, method] of methods.entries()) {
    const given = scenario();
    const effects = {
      ...given.effects,
      [method]: [{ kind: "refused", reason: "budget-exhausted" }],
    };
    const [line] = await ran([{ ...given, effects }]);
    assert.equal(field(field(line, "outcome"), "reason"), "budget-exhausted");
    assert.equal(field(field(line, "requests"), "length"), index + 1);
  }
  const [line] = await ran([{ ...scenario(), effectLimit: 1 }]);
  assert.equal(field(field(line, "outcome"), "reason"), "budget-exhausted");
  assert.equal(field(line, "spent"), 1);
});

await test("CLV-116 unusable read and turn results block before later effects", async () => {
  for (const [method, code, count] of [
    ["chats read-analysis", "analysis-input-refused", 1],
    ["claude run-turn:analyze-chats", "analysis-turn-failed", 2],
  ] as const) {
    const given = scenario();
    const [line] = await ran([
      { ...given, effects: { ...given.effects, [method]: [completed({})] } },
    ]);
    assert.equal(field(field(line, "outcome"), "reason"), code);
    assert.equal(field(field(line, "requests"), "length"), count);
  }
});

await test("CLV-148 a valid private draft opens one candidate-bound question with its stored deadline", async () => {
  const [line, repeated] = await ran([draftScenario(), draftScenario()]);
  assert.deepEqual(field(line, "outcome"), {
    kind: "waiting_for_decision",
    cycleId: input.cycleId,
    decisionId: "analysis-question",
  });
  assert.equal(field(line, "spent"), 3);
  assert.equal(field(field(line, "requests"), "length"), 4);
  const gate = request(line, 3);
  assert.equal(field(gate, "gateId"), "analysis-question");
  assert.equal(field(gate, "kind"), "question");
  assert.equal(field(gate, "expiresAt"), "2026-10-21T10:00:00.000Z");
  assert.deepEqual(gate, request(repeated, 3));
  const prompt = String(field(gate, "prompt"));
  assert.ok(prompt.includes("a".repeat(64)));
  for (const choice of questionCandidate().openQuestion.choices) {
    assert.ok(prompt.includes(choice.id));
    assert.ok(prompt.includes(choice.description));
  }
});

await test("CLV-148 an answer with text beyond the listed ID blocks without another question or turn", async () => {
  const [line] = await ran([
    {
      ...draftScenario(),
      decision: {
        gateId: "analysis-question",
        decision: "answered",
        answer: "earlier with extra text",
      },
    },
  ]);
  assert.deepEqual(field(line, "outcome"), {
    kind: "blocked",
    cycleId: input.cycleId,
    reason: "analysis-answer-invalid",
    evidenceId: "analysis-question",
  });
  assert.equal(field(field(line, "requests"), "length"), 3);
  assert.equal(field(line, "spent"), 3);
});

await test("CLV-148 an expired question blocks with analysis-answer-missing and opens no later question", async () => {
  const [line] = await ran([
    {
      ...draftScenario(),
      decision: {
        gateId: "analysis-question",
        decision: "expired",
        answer: null,
      },
    },
  ]);
  assert.equal(
    field(field(line, "outcome"), "reason"),
    "analysis-answer-missing",
  );
  assert.equal(field(field(line, "requests"), "length"), 3);
});

await test("CLV-149 an exact choice runs one second turn and final save with five units", async () => {
  const [line, initial] = await ran([answeredScenario(), draftScenario()]);
  assert.deepEqual(field(line, "outcome"), {
    kind: "handoff_requested",
    cycleId: input.cycleId,
    promotionId: `analysis:${importId}:${input.cycleId}`,
  });
  assert.equal(field(line, "spent"), 5);
  assert.equal(field(field(line, "requests"), "length"), 5);
  for (const index of [0, 1, 2])
    assert.deepEqual(request(line, index), request(initial, index));
  for (const index of [3, 4]) {
    assert.equal(field(request(line, index), "units"), 1);
    assert.equal(field(field(request(line, index), "scope"), "round"), 2);
  }
  assert.deepEqual(JSON.parse(String(field(request(line, 3), "payload"))), {
    snapshot,
    followUp: { draft: questionCandidate(), answer: "earlier" },
  });
  assert.deepEqual(JSON.parse(String(field(request(line, 4), "payload"))), {
    importId,
    cycleId: input.cycleId,
    snapshot,
    reply,
    followUp: { draft: questionCandidate(), answer: "earlier" },
  });
});

await test("CLV-148 a continuation for a different gate or without a saved question cannot report accepted output", async () => {
  const lines = await ran([
    {
      ...draftScenario(),
      decision: { gateId: "other", decision: "answered", answer: "earlier" },
    },
    {
      ...scenario(),
      decision: {
        gateId: "analysis-question",
        decision: "answered",
        answer: "earlier",
      },
    },
  ]);
  for (const line of lines) {
    assert.equal(
      field(field(line, "outcome"), "reason"),
      "analysis-answer-invalid",
    );
    assert.equal(field(field(line, "requests"), "length"), 3);
  }
});

await test("CLV-148 refused or unavailable question gates block without a later effect", async () => {
  const lines = await ran(
    ["refused", "unavailable"].map((kind) => ({
      ...draftScenario(),
      gate: { kind, reason: "gate-unavailable" },
    })),
  );
  for (const line of lines) {
    assert.equal(field(field(line, "outcome"), "reason"), "gate-unavailable");
    assert.equal(field(field(line, "requests"), "length"), 4);
    assert.equal(field(line, "spent"), 3);
  }
});

await test("CLV-148 unusable draft bindings cannot open a question", async () => {
  for (const changed of [
    { cycleId: "different-cycle" },
    { candidateDigest: "opaque" },
    { expiresAt: null },
    { question: null },
  ]) {
    const given = draftScenario();
    const [line] = await ran([
      {
        ...given,
        effects: {
          ...given.effects,
          "chats save-analysis": [
            completed({
              kind: "analysis_draft",
              cycleId: input.cycleId,
              candidateDigest: "a".repeat(64),
              expiresAt: "2026-10-21T10:00:00.000Z",
              question: questionCandidate().openQuestion,
              ...changed,
            }),
          ],
        },
      },
    ]);
    assert.equal(
      field(field(line, "outcome"), "reason"),
      "analysis-input-refused",
    );
    assert.equal(field(field(line, "requests"), "length"), 3);
  }
});

await test("CLV-149 only the exact listed IDs allow a second turn", async () => {
  for (const answer of ["earlier", "later"]) {
    const given = answeredScenario();
    const [line] = await ran([
      { ...given, decision: { ...given.decision, answer } },
    ]);
    assert.equal(field(field(line, "outcome"), "kind"), "handoff_requested");
    assert.equal(field(line, "spent"), 5);
  }
  for (const answer of [
    " earlier",
    "earlier ",
    "EARLIER",
    "unknown",
    "",
    null,
  ]) {
    const given = answeredScenario();
    const [line] = await ran([
      { ...given, decision: { ...given.decision, answer } },
    ]);
    assert.equal(
      field(field(line, "outcome"), "reason"),
      "analysis-answer-invalid",
    );
    assert.equal(field(field(line, "requests"), "length"), 3);
    assert.equal(field(line, "spent"), 3);
  }
});
