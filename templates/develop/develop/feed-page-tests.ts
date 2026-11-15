import assert from "node:assert/strict";
import { fakeStepBridge } from "cloving/workflows/testing";
import { developFeed } from "../develop.ts";

function issue(number: number, body = "Small.") {
  return {
    number,
    title: `Task ${String(number)}`,
    body,
    url: `https://github.com/acme/demo/issues/${String(number)}`,
    createdAt: "2026-11-01T00:00:00Z",
  };
}

function page(issues: readonly object[], cursor: number | null = null) {
  const result = JSON.stringify({ issues, cursor });
  assert.ok(new TextEncoder().encode(result).length <= 262144);
  return {
    kind: "completed" as const,
    operationId: "page",
    receipt: null,
    result,
  };
}

async function feedReadsPages() {
  using bridge = fakeStepBridge({
    effects: {
      "github issues": [
        page(
          [
            issue(5, "x".repeat(60 * 1024)),
            issue(4, "x".repeat(60 * 1024)),
            issue(3, "x".repeat(60 * 1024)),
            issue(2, "x".repeat(60 * 1024)),
          ],
          4,
        ),
        page([issue(1, "x".repeat(60 * 1024)), issue(6)]),
      ],
    },
  });
  const result = await developFeed();
  assert.deepEqual(
    result.picks.map((pick) => pick.id),
    ["1", "2", "3", "4"],
  );
  assert.deepEqual(result.skipped, [
    { id: "5", reason: "feed result too large" },
    { id: "6", reason: "feed result too large" },
  ]);
  const payload = {
    labels: ["cloving: ready"],
    state: "open",
    limit: 100,
    maximumBodyBytes: 65536,
  };
  assert.deepEqual(
    bridge.requests.map((request) => {
      assert.equal(request[0], "effect");
      return {
        payload: JSON.parse(request[1].payload) as unknown,
        round: request[1].scope.round,
      };
    }),
    [
      { payload: { ...payload, cursor: 0 }, round: 1 },
      { payload: { ...payload, cursor: 4 }, round: 2 },
    ],
  );
}

async function feedOmittedBody() {
  using bridge = fakeStepBridge({
    effects: {
      "github issues": [
        page([{ ...issue(738), bodyOmitted: "result-too-large" }, issue(740)]),
      ],
    },
  });
  const result = await developFeed();
  assert.equal(bridge.requests.length, 1);
  assert.deepEqual(
    result.picks.map((pick) => pick.id),
    ["740"],
  );
  assert.deepEqual(result.skipped, [
    { id: "738", reason: "issue result too large" },
  ]);
}

export const feedPageTests = [
  {
    name: "CLV-363 developFeed follows bounded issue pages for five large tickets",
    run: feedReadsPages,
  },
  {
    name: "CLV-363 developFeed preserves the omitted body marker and selects unrelated work",
    run: feedOmittedBody,
  },
];

async function feedPageFailures() {
  for (const cursor of [0, 4, 1000]) {
    using bridge = fakeStepBridge({
      effects: { "github issues": [page([], 4), page([], cursor)] },
    });
    await assert.rejects(developFeed(), {
      message: cursor === 1000 ? "issues-limit" : "invalid-feed-result",
    });
    assert.equal(bridge.requests.length, 2);
  }
  using bridge = fakeStepBridge({
    effects: {
      "github issues": [
        page([], 10),
        { kind: "failed", operationId: "page", reason: "page-failed" },
      ],
    },
  });
  await assert.rejects(developFeed(), { message: "page-failed" });
  assert.equal(bridge.requests.length, 2);
}

async function feedBoundedIssues() {
  const pages = Array.from({ length: 12 }, (_, index) =>
    page(
      Array.from({ length: 10 }, (_, item) => issue(index * 10 + item + 1)),
      (index + 1) * 10,
    ),
  );
  using bridge = fakeStepBridge({
    effects: { "github issues": [page([issue(1)], 1), ...pages] },
  });
  const result = await developFeed();
  assert.equal(bridge.requests.length, 11);
  assert.deepEqual(
    result.picks.map((pick) => pick.id),
    Array.from({ length: 20 }, (_, index) => String(index + 1)),
  );
}

feedPageTests.push(
  {
    name: "CLV-363 developFeed rejects invalid or failed continuation pages",
    run: feedPageFailures,
  },
  {
    name: "CLV-363 developFeed deduplicates issue pages and stops at one hundred ready issues",
    run: feedBoundedIssues,
  },
);

async function feedEncodedPages() {
  const body = "\u0000".repeat(40000);
  const pages = Array.from({ length: 50 }, (_, index) =>
    page(
      Array.from({ length: 2 }, (_, item) => ({
        ...issue(index * 2 + item + 1, btoa(body)),
        bodyEncoding: "base64",
      })),
      index === 49 ? null : (index + 1) * 2,
    ),
  );
  using bridge = fakeStepBridge({
    effectLimit: 87,
    effects: { "github issues": pages },
  });
  const result = await developFeed();
  assert.equal(bridge.requests.length, 50);
  assert.equal(result.picks.length, 1);
  assert.equal(result.picks[0]?.id, "1");
  assert.ok(
    result.picks[0].text === `# Task 1\n\nGitHub issue: acme/demo#1\n\n${body}`,
  );
}

feedPageTests.push({
  name: "CLV-363 one hundred escaped bodies fit within the unchanged feed effect budget",
  run: feedEncodedPages,
});

function closedStates(numbers: readonly number[]) {
  return {
    kind: "completed" as const,
    operationId: "states",
    receipt: null,
    result: JSON.stringify(
      numbers.map((number) => ({ number, state: "closed" })),
    ),
  };
}

async function feedBlockerBudget() {
  const numbers = Array.from({ length: 4400 }, (_, index) => index + 1);
  const heavy = issue(
    738,
    `## Dependencies\nNeeds ${numbers.map((number) => `#${String(number)}`).join(", ")}.`,
  );
  assert.ok(new TextEncoder().encode(heavy.body).length < 65536);
  for (const pageCount of [1, 50]) {
    const pages = Array.from({ length: pageCount }, (_, index) =>
      page(
        index === pageCount - 1
          ? [heavy, issue(740, "## Dependencies\nNeeds #734."), issue(742)]
          : [],
        index === pageCount - 1 ? null : index + 1,
      ),
    );
    using bridge = fakeStepBridge({
      effectLimit: 87,
      effects: {
        "github issues": pages,
        "github issue-states": Array.from({ length: 88 }, () =>
          closedStates([734]),
        ),
      },
    });
    const result = await developFeed();
    assert.deepEqual(
      result.picks.map((pick) => pick.id),
      ["740", "742"],
    );
    assert.deepEqual(result.skipped, [{ id: "738", reason: "waits for #1" }]);
    assert.equal(bridge.spent, pageCount + 1);
    assert.deepEqual(
      bridge.requests.slice(pageCount).map((request) => {
        assert.equal(request[0], "effect");
        assert.equal(request[1].method, "issue-states");
        return JSON.parse(request[1].payload) as unknown;
      }),
      [{ numbers: [734] }],
    );
  }
}

async function feedExactBlockerBudget() {
  for (const pageCount of [1, 50]) {
    const numbers = Array.from(
      { length: (87 - pageCount) * 50 },
      (_, index) => index + 1,
    );
    const heavy = issue(
      738,
      `## Dependencies\nNeeds ${numbers.map((number) => `#${String(number)}`).join(", ")}.`,
    );
    const pages = Array.from({ length: pageCount }, (_, index) =>
      page(
        index === pageCount - 1 ? [heavy, issue(740)] : [],
        index === pageCount - 1 ? null : index + 1,
      ),
    );
    const batches = Array.from({ length: 87 - pageCount }, (_, index) =>
      closedStates(numbers.slice(index * 50, (index + 1) * 50)),
    );
    using bridge = fakeStepBridge({
      effectLimit: 87,
      effects: { "github issues": pages, "github issue-states": batches },
    });
    const result = await developFeed();
    assert.deepEqual(
      result.picks.map((pick) => pick.id),
      ["738", "740"],
    );
    assert.deepEqual(result.skipped, []);
    assert.equal(bridge.spent, 87);
    assert.equal(bridge.requests.length, 87);
  }
}

feedPageTests.push(
  {
    name: "CLV-363 an over-budget blocker list skips only its ticket after issue pagination",
    run: feedBlockerBudget,
  },
  {
    name: "CLV-363 blocker reads can use exactly the remaining feed effect budget",
    run: feedExactBlockerBudget,
  },
);
