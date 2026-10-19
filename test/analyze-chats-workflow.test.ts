import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { checkSubmission } from "../src/submission.ts";
import { isWorkflowDeclaration } from "../src/workflow-declaration.ts";
import { candidate } from "./chats-analysis-fixture.ts";
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

await test("CLV-117 a saved draft cannot report a handoff before question integration", async () => {
  const given = scenario();
  const [line] = await ran([
    {
      ...given,
      effects: {
        ...given.effects,
        "chats save-analysis": [
          completed({
            kind: "analysis_draft",
            cycleId: input.cycleId,
            candidateDigest: "opaque",
            expiresAt: "2026-10-20T10:00:00.000Z",
          }),
        ],
      },
    },
  ]);
  assert.deepEqual(field(line, "outcome"), {
    kind: "blocked",
    cycleId: input.cycleId,
    reason: "analysis-input-refused",
    evidenceId: "save-analysis",
  });
  assert.equal(field(line, "spent"), 3);
  assert.equal(field(field(line, "requests"), "length"), 3);
});
