import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { checkSubmission } from "../src/submission.ts";
import { isWorkflowDeclaration } from "../src/workflow-declaration.ts";
import { candidate, questionCandidate } from "./chats-analysis-fixture.ts";
import { corpus, importId, manifest, sidecar } from "./chats-worker-fixture.ts";
import { field, ran, request } from "./develop-workflow-fixture.ts";

const input = {
  cycleId: "analysis-cycle",
  repository: "unused",
  input: { importId },
};
const snapshot = {
  importId,
  redaction: JSON.stringify(manifest),
  corpus,
  structure: JSON.stringify(sidecar),
};
const reply = JSON.stringify(candidate());
const completed = (value: unknown) => ({
  kind: "completed",
  operationId: "opaque",
  receipt: "opaque",
  result: JSON.stringify(value),
});

function scenario() {
  return {
    workflow: "analyze-chats",
    input,
    effectLimit: 3,
    effects: {
      "chats read-analysis": [completed({ snapshot })],
      "claude run-turn:analyze-chats": [
        completed({ reply, usage: { input_tokens: 20 } }),
      ],
      "chats save-analysis": [
        completed({
          kind: "handoff_requested",
          cycleId: input.cycleId,
          promotionId: `analysis:${importId}:${input.cycleId}`,
        }),
      ],
    },
  };
}

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

await test("CLV-116 submission declares exactly one required import ID and three effect units", () => {
  const declaration: unknown = JSON.parse(
    readFileSync(
      new URL("../workflows/analyze-chats.declaration.json", import.meta.url),
      "utf8",
    ),
  );
  assert.ok(isWorkflowDeclaration(declaration));
  assert.equal(declaration.workflowId, "analyze-chats");
  assert.equal(declaration.effectLimit, 3);
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

function draftScenario() {
  const given = scenario();
  return {
    ...given,
    gate: { kind: "opened", decisionId: "analysis-question" },
    effects: {
      ...given.effects,
      "claude run-turn:analyze-chats": [
        completed({ reply: JSON.stringify(questionCandidate()) }),
      ],
      "chats save-analysis": [
        completed({
          kind: "analysis_draft",
          cycleId: input.cycleId,
          candidateDigest: "a".repeat(64),
          expiresAt: "2026-10-21T10:00:00.000Z",
          question: questionCandidate().openQuestion,
        }),
      ],
    },
  };
}

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

await test("CLV-148 only exact listed choice IDs reach the pending second-turn boundary", async () => {
  const answers = [
    "earlier",
    "later",
    " earlier",
    "earlier ",
    "EARLIER",
    "unknown",
    "",
    null,
  ];
  const lines = await ran(
    answers.map((answer) => ({
      ...draftScenario(),
      decision: { gateId: "analysis-question", decision: "answered", answer },
    })),
  );
  for (const [index, line] of lines.entries()) {
    assert.deepEqual(field(line, "outcome"), {
      kind: "blocked",
      cycleId: input.cycleId,
      reason: index < 2 ? "analysis-input-refused" : "analysis-answer-invalid",
      evidenceId: "analysis-question",
    });
    assert.equal(field(field(line, "requests"), "length"), 3);
  }
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
