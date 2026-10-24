import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Linter } from "eslint";
import typescript from "typescript-eslint";
import { field, ran, request } from "./develop-workflow-fixture.ts";
import { withConsumer } from "./world-host-fixture.ts";

const input = {
  cycleId: "prd-75",
  ticket: "Show the cost of each run on the watch page",
};
const operations = [
  "github-prepare",
  "claude-research",
  "claude-review",
  "github-create-issue",
  "github-discard",
];

await test("CLV-075 issue validation uses guard clauses without nested conditions", () => {
  const source = readFileSync(
    new URL("../workflows/develop-prd.ts", import.meta.url),
    "utf8",
  );
  const messages = new Linter().verify(
    source,
    {
      files: ["**/*.ts"],
      languageOptions: { parser: typescript.parser },
      rules: {
        "no-restricted-syntax": [
          "error",
          {
            selector: "IfStatement IfStatement",
            message: "Use guard clauses instead of nested conditions.",
          },
        ],
      },
    },
    { filename: "develop-prd.ts" },
  );
  assert.deepEqual(messages, []);
});

function completed(result: unknown): unknown {
  return {
    kind: "completed",
    operationId: "operation",
    receipt: "receipt",
    result: JSON.stringify(result),
  };
}

function scenario(
  created: unknown,
  effects: Readonly<Record<string, readonly unknown[]>> = {},
): unknown {
  return {
    workflow: "develop-prd",
    input,
    effects: {
      "github prepare": [completed({})],
      "claude run-turn": [completed({}), completed({})],
      "github create-issue": [created],
      "github discard": [completed({})],
      ...effects,
    },
  };
}

await test("CLV-075 researches, reviews, posts and discards in order", async () => {
  const [line] = await ran([
    scenario(
      completed({ number: 75, url: "https://github.com/acme/demo/issues/75" }),
    ),
  ]);
  assert.deepEqual(field(line, "outcome"), {
    kind: "handoff_requested",
    cycleId: input.cycleId,
    promotionId: "issue-75",
  });
  assert.deepEqual(
    operations.map((_, index) =>
      field(field(request(line, index), "scope"), "operation"),
    ),
    operations,
  );
  checkPrompts(line);
});

for (const [label, ending] of [
  [completed({}), {}],
  [{ kind: "refused", reason: "budget-exhausted" }, { issueUpdate: "failed" }],
] as const)
  await test(`CLV-169 a handoff timeout queues its issue and exposes label result ${JSON.stringify(ending)}`, async () => {
    const [line] = await ran([
      scenario(
        completed({
          number: 75,
          url: "https://github.com/acme/demo/issues/75",
        }),
        {
          "github label": [label],
          handoff: [{ kind: "failed", reason: "handoff-start-timeout" }],
        },
      ),
    ]);
    assert.deepEqual(field(line, "outcome"), {
      kind: "handoff_requested",
      cycleId: input.cycleId,
      promotionId: "issue-75",
      reason: "handoff-start-timeout",
      ...ending,
    });
    assert.deepEqual(request(line, 4), {
      scope: { phase: "prd", operation: "github-ready", round: 1 },
      capability: "github",
      method: "label",
      target: input.cycleId,
      units: 1,
      payload: JSON.stringify({
        owner: "acme",
        repository: "demo",
        number: 75,
        add: ["cloving: ready"],
        remove: [],
      }),
    });
    assert.equal(field(request(line, 5), "method"), "discard");
  });

function checkPrompts(line: unknown): void {
  const research = String(field(request(line, 1), "payload"));
  assert.ok(research.includes(input.ticket));
  for (const text of [
    "code",
    "web",
    "# <title>",
    "Problem",
    "Desired outcome",
    "Concrete scenario",
    "Scope",
    "Non-goals",
    "Acceptance criteria",
    "TDD entry points",
    "Dependencies",
    "Sources",
    "Do not commit",
    "do not push",
  ])
    assert.ok(research.includes(text), text);
  const payload: unknown = JSON.parse(
    String(field(request(line, 3), "payload")),
  );
  const draft = String(field(payload, "draft"));
  assert.ok(research.includes(draft));
  const review = String(field(request(line, 2), "payload"));
  for (const text of [
    draft,
    "each claim",
    "code",
    "local paths",
    "private names",
    "secrets",
    "GitHub logins",
    "other repositories",
  ])
    assert.ok(review.includes(text), text);
}

await test("CLV-075 a refused post blocks the run and preserves the draft", async () => {
  const [line] = await ran([
    scenario({
      kind: "failed",
      operationId: "operation",
      reason: "private-path-in-change",
    }),
  ]);
  assert.deepEqual(field(line, "outcome"), {
    kind: "blocked",
    cycleId: input.cycleId,
    reason: "private-path-in-change",
    evidenceId: "github-create-issue",
  });
  assert.equal(field(field(line, "requests"), "length"), 4);
});

for (const [created, reason] of [
  [completed({}), "invalid-issue-result"],
  [
    { kind: "failed", operationId: "operation", reason: "post-refused" },
    "post-refused",
  ],
] as const)
  await test(`CLV-169 compiled PRD makes no handoff after ${reason}`, () =>
    withConsumer(
      readFileSync(
        new URL("../workflows/develop-prd.ts", import.meta.url),
        "utf8",
      ),
      async (consumer) => {
        const result = await consumer.run(`
const requests = [];
globalThis[Symbol.for("cloving.step-bridge/v1")] = {
  effect: async (request) => {
    requests.push(request.scope.operation);
    return request.method === "create-issue" ? ${JSON.stringify(created)} : ${JSON.stringify(completed({}))};
  },
  gate: async () => { throw new Error("unexpected-gate"); },
  handoff: async () => { requests.push("handoff"); throw new Error("unexpected-handoff"); },
};
const opened = await startHost({ dataDirectory, concurrency: 1, handler: POST });
if (opened.kind !== "started") throw new Error(opened.reason);
try {
  const run = await start(workflows.developPrd, [${JSON.stringify(input)}]);
  const outcome = await getRun(run.runId).returnValue;
  const runs = await (await getWorld()).runs.list({ resolveData: "none", pagination: { limit: 10 } });
  print({ outcome, requests, runs: runs.data.length });
} finally { await opened.host.close(); }
`);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(result.lines, [
          {
            outcome: {
              kind: "blocked",
              cycleId: input.cycleId,
              reason,
              evidenceId: "github-create-issue",
            },
            requests: operations.slice(0, 4),
            runs: 1,
          },
        ]);
      },
    ));

await test("CLV-075 invalid issue results block handoff and preserve the draft", async () => {
  const invalid = [
    null,
    [],
    {},
    "75",
    75,
    true,
    ...[null, "75", 0, -1, 1.5, 9007199254740992].map((number) => ({ number })),
  ];
  const results = [
    ...invalid.map(completed),
    { kind: "completed", operationId: "operation", receipt: "receipt" },
    {
      kind: "completed",
      operationId: "operation",
      receipt: "receipt",
      result: "not json",
    },
  ];
  const lines = await ran(results.map((result) => scenario(result)));
  for (const line of lines) {
    assert.deepEqual(field(line, "outcome"), {
      kind: "blocked",
      cycleId: input.cycleId,
      reason: "invalid-issue-result",
      evidenceId: "github-create-issue",
    });
    assert.equal(field(field(line, "requests"), "length"), 4);
  }
});

await test("CLV-075 every incomplete step blocks the workflow without later effects", async () => {
  const created = completed({ number: 75 });
  const failed = { kind: "failed", operationId: "operation", reason: null };
  const refused = { kind: "refused", reason: "budget-exhausted" };
  const cases = [
    scenario(created, { "github prepare": [failed] }),
    scenario(created, { "claude run-turn": [refused] }),
    scenario(created, { "claude run-turn": [completed({}), refused] }),
    scenario(created, { "github discard": [failed] }),
  ];
  const lines = await ran(cases);
  const expected = [
    { operation: "github-prepare", reason: "failed", count: 1 },
    { operation: "claude-research", reason: "budget-exhausted", count: 2 },
    { operation: "claude-review", reason: "budget-exhausted", count: 3 },
    { operation: "github-discard", reason: "failed", count: 5 },
  ];
  for (const [index, line] of lines.entries()) {
    assert.deepEqual(field(line, "outcome"), {
      kind: "blocked",
      cycleId: input.cycleId,
      reason: expected[index]?.reason,
      evidenceId: expected[index]?.operation,
    });
    assert.equal(
      field(field(line, "requests"), "length"),
      expected[index]?.count,
    );
  }
});
