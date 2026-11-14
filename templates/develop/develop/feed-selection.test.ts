import {
  readyIssuesOf,
  readyIssuePageOf,
  blockerStatesOf,
} from "./feed-results.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { blockerNumbersOf, blockersOf, selected } from "./feed-selection.ts";

function issue(
  number: number,
  options: { body?: string; createdAt?: string } = {},
) {
  const { body = "", createdAt = "2026-11-01T00:00:00Z" } = options;
  return {
    number,
    body,
    createdAt,
    title: `Task ${String(number)}`,
    url: `https://github.com/acme/demo/issues/${String(number)}`,
  };
}

await test("CLV-363 selection uses the dependency sentence rules", () => {
  assert.deepEqual(
    blockersOf(
      "Needs #1.\n## Dependencies\nNeeds #734 and #702.\n- Needs #734.\nNot Needs #3.\n## Notes\nNeeds #4.",
    ),
    [734, 702],
  );
});

await test("CLV-363 selection orders picks oldest first then by number and uses the ticket text form", () => {
  const ready = [
    issue(740, { body: "Body.", createdAt: "2026-11-02T00:00:00Z" }),
    issue(739),
    issue(738),
  ];
  assert.deepEqual(selected(ready, { states: [], active: [] }), {
    picks: [738, 739, 740].map((number) => ({
      id: String(number),
      text: `# Task ${String(number)}\n\nGitHub issue: acme/demo#${String(number)}\n\n${number === 740 ? "Body." : ""}`,
    })),
    skipped: [],
  });
  assert.deepEqual(
    ready.map((item) => item.number),
    [740, 739, 738],
  );
});

await test("CLV-363 selection skips active tickets and open, missing or unknown blockers", () => {
  const ready = [
    issue(738, { body: "## Dependencies\nNeeds #734." }),
    issue(739, { body: "## Dependencies\nNeeds #702 and #700." }),
    issue(740),
    issue(741, { body: "## Dependencies\nNeeds #999." }),
    issue(742, { body: "## Dependencies\nNeeds #702." }),
  ];
  const result = selected(ready, {
    states: [
      { number: 734, state: "open" },
      { number: 702, state: "closed" },
      { number: 700, state: "missing" },
    ],
    active: ["740"],
  });
  assert.deepEqual(result.skipped, [
    { id: "738", reason: "waits for #734" },
    { id: "739", reason: "waits for #700" },
    { id: "740", reason: "in work" },
    { id: "741", reason: "waits for #999" },
  ]);
  assert.deepEqual(
    result.picks.map((pick) => pick.id),
    ["742"],
  );
});

await test("CLV-363 selection keeps feed pick and skipped counts within the host bounds", () => {
  const ready = Array.from({ length: 100 }, (_, index) => issue(index + 1));
  assert.equal(selected(ready, { states: [], active: [] }).picks.length, 20);
  assert.equal(
    selected(ready, {
      states: [],
      active: ready.map((item) => String(item.number)),
    }).skipped.length,
    50,
  );
});

await test("CLV-363 selection skips oversized ticket text without truncating valid text", () => {
  const result = selected(
    [
      issue(738, { body: "é".repeat(32768) }),
      issue(740, { body: "Valid body." }),
    ],
    { states: [], active: [] },
  );
  assert.deepEqual(result.skipped, [{ id: "738", reason: "ticket too large" }]);
  assert.deepEqual(result.picks, [
    {
      id: "740",
      text: "# Task 740\n\nGitHub issue: acme/demo#740\n\nValid body.",
    },
  ]);
});

await test("CLV-363 selection keeps escaped JSON within the feed result byte limit", () => {
  const ready = Array.from({ length: 20 }, (_, index) =>
    issue(index + 1, { body: "\u0000".repeat(15000) }),
  );
  const result = selected(ready, { states: [], active: [] });
  assert.ok(new TextEncoder().encode(JSON.stringify(result)).length <= 262144);
  assert.ok(result.picks.length > 0);
  assert.ok(result.skipped.length > 0);
  assert.deepEqual(
    result.skipped.map((item) => item.id),
    Array.from({ length: 18 }, (_, index) => String(index + 3)),
  );
});

await test("CLV-363 feed result readers preserve valid rows and reject malformed data", () => {
  const ready = issue(740, { body: "Work." });
  assert.deepEqual(readyIssuesOf(JSON.stringify([ready])), [ready]);
  const states = [
    { number: 734, state: "open" },
    { number: 702, state: "closed" },
    { number: 700, state: "missing" },
  ];
  assert.deepEqual(blockerStatesOf(JSON.stringify(states)), states);
  for (const value of [
    null,
    {},
    [null],
    [{ ...ready, number: 0 }],
    [{ ...ready, body: null }],
  ])
    assert.throws(() => readyIssuesOf(JSON.stringify(value)), {
      message: "invalid-feed-result",
    });
  for (const value of [
    null,
    {},
    [null],
    [{ number: 1, state: "merged" }],
    [{ number: 1.5, state: "open" }],
  ])
    assert.throws(() => blockerStatesOf(JSON.stringify(value)), {
      message: "invalid-feed-result",
    });
});

await test("CLV-363 selection skips an omitted body instead of admitting an empty ticket", () => {
  const ready = [
    { ...issue(738), bodyOmitted: "result-too-large" as const },
    issue(740),
  ];
  const result = selected(ready, { states: [], active: [] });
  assert.deepEqual(
    result.picks.map((pick) => pick.id),
    ["740"],
  );
  assert.deepEqual(result.skipped, [
    { id: "738", reason: "issue result too large" },
  ]);
});

await test("CLV-363 feed page readers reject invalid cursors and omitted body markers", () => {
  const ready = { ...issue(740), bodyOmitted: "result-too-large" as const };
  assert.deepEqual(
    readyIssuePageOf(JSON.stringify({ issues: [ready], cursor: 10 })),
    { issues: [ready], cursor: 10 },
  );
  for (const cursor of [undefined, 0, -1, 1.5, 1001, "1"])
    assert.throws(
      () => readyIssuePageOf(JSON.stringify({ issues: [], cursor })),
      { message: "invalid-feed-result" },
    );
  assert.throws(
    () => readyIssuesOf(JSON.stringify([{ ...ready, bodyOmitted: true }])),
    { message: "invalid-feed-result" },
  );
});

await test("CLV-363 encoded issue bodies preserve UTF-8 and a leading byte order mark", () => {
  const body = "\uFEFF\u0000é";
  const encoded = btoa(
    Array.from(new TextEncoder().encode(body), (byte) =>
      String.fromCharCode(byte),
    ).join(""),
  );
  const ready = { ...issue(740), body: encoded, bodyEncoding: "base64" };
  const page = readyIssuePageOf(
    JSON.stringify({ issues: [ready], cursor: null }),
  );
  assert.equal(page.issues[0]?.body, body);
  for (const invalid of [
    { bodyEncoding: "hex", body: encoded },
    { bodyEncoding: "base64", body: "YQ" },
    { bodyEncoding: "base64", body: "/w==" },
  ])
    assert.throws(() =>
      readyIssuesOf(JSON.stringify([{ ...ready, ...invalid }])),
    );
  assert.deepEqual(
    selected([{ ...issue(738), bodyOmitted: "body-limit" }], {
      states: [],
      active: [],
    }).skipped,
    [{ id: "738", reason: "ticket too large" }],
  );
});

await test("CLV-363 blocker reads prioritize oldest tickets and omit lists that exceed the remaining budget", () => {
  const ready = [
    issue(740, { body: "## Dependencies\nNeeds #4." }),
    issue(739, { body: "## Dependencies\nNeeds #1 and #2." }),
    issue(738, { body: "## Dependencies\nNeeds #1, #2 and #3." }),
  ];
  assert.deepEqual(blockerNumbersOf(ready, 2), [1, 2]);
  assert.deepEqual(blockerNumbersOf(ready, 0), []);
  assert.deepEqual(
    blockerNumbersOf(
      [
        issue(739, { body: "## Dependencies\nNeeds #1 and #2." }),
        issue(738, { body: "## Dependencies\nNeeds #1." }),
      ],
      2,
    ),
    [1, 2],
  );
});
