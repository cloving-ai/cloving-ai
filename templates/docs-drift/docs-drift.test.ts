import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeStepBridge } from "cloving/workflows/testing";
import { docsDrift } from "./docs-drift.ts";
import { refusalTests } from "./docs-drift/refusal-tests.ts";
import {
  candidate,
  commit,
  completed,
  created,
  payloads,
  ticket,
  effects,
  input,
  methods,
  payloadOf,
  row,
  scan,
  tickets,
} from "./docs-drift/scenarios.ts";

await test("CLV-317 a doc that says 30 where the code has 60 gives one ticket with the row and its evidence", async () => {
  using bridge = fakeStepBridge({
    effects: effects(scan([candidate("README.md"), candidate("AGENTS.md")]), {
      docs: [{ doc: "README.md", rows: [row()] }],
    }),
    effectLimit: 10,
  });
  const outcome = await docsDrift(input);
  assert.deepEqual(methods(bridge.requests), [
    "run:docs-candidates",
    "prepare",
    "run-turn",
    "discard",
    "handoff",
    "run:docs-drift-record",
  ]);
  const [text = "", other] = tickets(bridge.requests);
  assert.equal(other, undefined);
  assert.match(text, /^# Make `README\.md` match the code on main\n/);
  assert.ok(
    text
      .split("\n")
      .includes(
        "| 42 | The default of `queue.seconds` is 30. | The default of `queue.seconds` is 60. | `src/settings.ts:17` | `abc1234` |",
      ),
    text,
  );
  assert.deepEqual(
    JSON.parse(payloadOf(bridge.requests, "run:docs-drift-record")),
    {
      commit,
      docs: ["AGENTS.md"],
    },
  );
  assert.deepEqual(outcome, {
    kind: "handoff_requested",
    cycleId: input.cycleId,
    promotionId: "docs-drift",
    report:
      "Docs audited: 2 at 0123456789ab. Ticket runs requested: 1 (README.md). Left for a later audit: none.",
  });
});

await test("CLV-317 when main moved after the scan, the ticket, the record and the report name the commit of the audited tree", async () => {
  const moved = "fedcba9876543210fedcba9876543210fedcba98";
  using bridge = fakeStepBridge({
    effects: Object.assign(
      effects(scan([candidate("README.md"), candidate("AGENTS.md")]), {
        docs: [{ doc: "README.md", rows: [row()] }],
      }),
      {
        "github prepare": [
          completed({ worktree: "tree", base: "main", startCommit: moved }),
        ],
      },
    ),
    effectLimit: 10,
  });
  const outcome = await docsDrift(input);
  assert.match(tickets(bridge.requests)[0] ?? "", /at commit `fedcba987654`/);
  assert.deepEqual(
    JSON.parse(payloadOf(bridge.requests, "run:docs-drift-record")),
    { commit: moved, docs: ["AGENTS.md"] },
  );
  assert.equal(
    outcome.kind === "handoff_requested" ? outcome.report : "",
    "Docs audited: 2 at fedcba987654. Ticket runs requested: 1 (README.md). Left for a later audit: none.",
  );
});

await test("CLV-317 a row with no path:line is dropped, and a doc with no row left gets no ticket", async () => {
  using bridge = fakeStepBridge({
    effects: effects(scan([candidate("README.md"), candidate("AGENTS.md")]), {
      docs: [
        {
          doc: "AGENTS.md",
          rows: [
            row({ evidence: null }),
            row({ evidence: "src/settings.ts" }),
            row({ evidence: "/home/operator/settings.ts:3" }),
          ],
        },
        {
          doc: "README.md",
          rows: [row({ line: 7 }), row({ line: 9, evidence: "somewhere" })],
        },
      ],
    }),
    effectLimit: 10,
  });
  const outcome = await docsDrift(input);
  const texts = tickets(bridge.requests);
  assert.equal(texts.length, 1);
  assert.match(texts[0] ?? "", /^# Make `README\.md` match/);
  assert.match(texts[0] ?? "", /\n\| 7 \| /);
  assert.doesNotMatch(texts[0] ?? "", /\n\| 9 \| /);
  assert.equal(
    outcome.kind === "handoff_requested" ? outcome.report : "",
    "Docs audited: 2 at 0123456789ab. Ticket runs requested: 1 (README.md). Left for a later audit: none.",
  );
});

const sevenDocs = ["a", "b", "c", "d", "e", "f", "g"].map(
  (name) => `docs/${name}.md`,
);

await test("CLV-317 7 drifted docs hand off 5 tickets, the docs with the most rows first, and the record holds only the doc with no drift", async () => {
  const counts = [1, 3, 2, 5, 1, 4, 2];
  using bridge = fakeStepBridge({
    effects: effects(
      scan(
        sevenDocs.concat(["docs/h.md"]).map((doc) => candidate(doc)),
        { more: 2 },
      ),
      {
        docs: sevenDocs.map((doc, index) => ({
          doc,
          rows: Array.from({ length: counts[index] ?? 0 }, (_, number) =>
            row({ line: number + 1 }),
          ),
        })),
      },
    ),
    effectLimit: 10,
  });
  const outcome = await docsDrift(input);
  assert.deepEqual(
    tickets(bridge.requests).map((text) => /^# Make `(\S+)`/.exec(text)?.[1]),
    ["docs/d.md", "docs/f.md", "docs/b.md", "docs/c.md", "docs/g.md"],
  );
  assert.deepEqual(
    JSON.parse(payloadOf(bridge.requests, "run:docs-drift-record")),
    { commit, docs: ["docs/h.md"] },
  );
  assert.equal(
    outcome.kind === "handoff_requested" ? outcome.report : "",
    "Docs audited: 8 at 0123456789ab. Ticket runs requested: 5 (docs/d.md, docs/f.md, docs/b.md, docs/c.md, docs/g.md). Left for a later audit: docs/a.md, docs/e.md. Docs over the limit of 15: 2.",
  );
});

await test("CLV-317 a run with no drift ends completed with no issue and records each candidate", async () => {
  using bridge = fakeStepBridge({
    effects: effects(scan([candidate("README.md"), candidate("AGENTS.md")]), {
      docs: [{ doc: "AGENTS.md", rows: [] }],
    }),
    effectLimit: 10,
  });
  assert.deepEqual(await docsDrift(input), {
    kind: "handoff_requested",
    cycleId: input.cycleId,
    promotionId: "docs-drift",
    report: "Docs audited: 2 at 0123456789ab. No drift.",
  });
  assert.deepEqual(methods(bridge.requests), [
    "run:docs-candidates",
    "prepare",
    "run-turn",
    "discard",
    "run:docs-drift-record",
  ]);
  assert.deepEqual(
    JSON.parse(payloadOf(bridge.requests, "run:docs-drift-record")),
    { commit, docs: ["README.md", "AGENTS.md"] },
  );
});

await test("CLV-317 a run with no candidate ends completed with no turn and no record", async () => {
  using bridge = fakeStepBridge({
    effects: effects(scan([])),
    effectLimit: 10,
  });
  assert.deepEqual(await docsDrift(input), {
    kind: "handoff_requested",
    cycleId: input.cycleId,
    promotionId: "docs-drift",
    report: "No doc names code that changed after its last audit.",
  });
  assert.deepEqual(methods(bridge.requests), ["run:docs-candidates"]);
});

await test("CLV-317 the ticket has the PRD form, the table, the steps to fix each row and the doc-only criteria", async () => {
  using bridge = fakeStepBridge({
    effects: effects(scan([candidate("templates/x/README.md")]), {
      docs: [
        {
          doc: "templates/x/README.md",
          rows: [
            row({ says: "A | B", commit: "no commit" }),
            row({ line: 50, fix: "Name `invalid-input`\nas the refusal." }),
          ],
        },
      ],
    }),
  });
  await docsDrift(input);
  const [text = ""] = tickets(bridge.requests);
  const lines = text.split("\n");
  assert.deepEqual(
    lines.filter((line) => line.startsWith("#")),
    [
      "# Make `templates/x/README.md` match the code on main",
      "## Problem",
      "## Desired outcome",
      "## Concrete scenario",
      "## Scope",
      "## Non-goals",
      "## Acceptance criteria",
      "## First tests",
    ],
  );
  for (const expected of [
    "`templates/x/README.md` has 2 statements that do not match the code on main at commit `0123456789ab`. A reader who follows the doc fails.",
    "| Doc line | The doc says | The code does | Evidence | Commit |",
    "| 42 | A \\| B | The default of `queue.seconds` is 60. | `src/settings.ts:17` | not known |",
    "Today line 42 of `templates/x/README.md` says: A | B The code at `src/settings.ts:17` does this: The default of `queue.seconds` is 60. After the change, line 42 matches the code.",
    "1. Line 42: Change 30 to 60 on line 42.",
    "2. Line 50: Name `invalid-input` as the refusal.",
    "1. Each row of the table matches the code on main.",
    "2. The change touches only `templates/x/README.md`.",
    "3. Every other statement of `templates/x/README.md` stays.",
  ])
    assert.ok(lines.includes(expected), expected);
});

await test("CLV-317 the turn gets the candidates as data and the rules of the audit", async () => {
  const candidates = scan([candidate("README.md", { since: commit })]);
  using bridge = fakeStepBridge({ effects: effects(candidates) });
  await docsDrift(input);
  const text = payloadOf(bridge.requests, "run-turn");
  for (const part of [
    "untrusted data",
    "Do not change files",
    "path:line",
    "Do not guess",
    "most rows first",
    "48000 characters",
    "code comments",
    JSON.stringify(candidates),
  ])
    assert.ok(text.includes(part), part);
});

await test("CLV-317 a run with a ticket text creates one issue and adds the label cloving: docs", async () => {
  using bridge = fakeStepBridge({ effects: created(42), effectLimit: 12 });
  assert.deepEqual(await docsDrift(ticket), {
    kind: "handoff_requested",
    cycleId: ticket.cycleId,
    promotionId: "issue-42",
    report: "Created the docs issue #42.",
  });
  assert.deepEqual(payloads(bridge.requests), [
    ["create-issue", { text: ticket.input.text }],
    ["label", { number: 42, add: ["cloving: docs"], remove: [] }],
  ]);
});

await test("CLV-317 a failed or invalid issue blocks the ticket run before the label", async () => {
  for (const [result, reason] of [
    [
      { kind: "failed", operationId: "p", reason: "private-path-in-change" },
      "private-path-in-change",
    ],
    [{ kind: "stopped", operationId: "p", reason: null }, "stopped"],
    [
      { kind: "completed", operationId: "p", receipt: null, result: null },
      "invalid-issue-result",
    ],
    [
      { kind: "completed", operationId: "p", receipt: null, result: "{" },
      "invalid-issue-result",
    ],
    [completed({ number: 0 }), "invalid-issue-result"],
    [completed([42]), "invalid-issue-result"],
  ] as const) {
    using bridge = fakeStepBridge({
      effects: { "github create-issue": [result] },
    });
    const outcome = await docsDrift(ticket);
    assert.equal(outcome.kind === "blocked" ? outcome.reason : "", reason);
    assert.deepEqual(methods(bridge.requests), ["create-issue"]);
  }
});

await test("CLV-317 a failed label blocks the ticket run after the issue", async () => {
  using bridge = fakeStepBridge({
    effects: Object.assign(created(42), {
      "github label": [
        { kind: "failed" as const, operationId: "l", reason: "label-failed" },
      ],
    }),
  });
  const outcome = await docsDrift(ticket);
  assert.equal(
    outcome.kind === "blocked" ? outcome.reason : "",
    "label-failed",
  );
  assert.deepEqual(methods(bridge.requests), ["create-issue", "label"]);
});

for (const scenario of refusalTests) await test(scenario.name, scenario.run);
