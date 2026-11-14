import assert from "node:assert/strict";
import { fakeStepBridge } from "cloving/workflows/testing";
import { developFeed } from "../develop.ts";

const ready = [
  {
    number: 738,
    title: "First",
    body: "## Dependencies\nNeeds #734.",
    url: "https://github.com/acme/demo/issues/738",
    createdAt: "2026-11-01T00:00:00Z",
  },
  {
    number: 740,
    title: "Second",
    body: "Do it.",
    url: "https://github.com/acme/demo/issues/740",
    createdAt: "2026-11-02T00:00:00Z",
  },
];

export async function feedSelectionScenario() {
  for (const state of ["open", "closed"]) {
    using bridge = fakeStepBridge({
      effects: {
        "github issues": [
          {
            kind: "completed",
            operationId: "ready",
            receipt: null,
            result: JSON.stringify(ready),
          },
        ],
        "github issue-states": [
          {
            kind: "completed",
            operationId: "states",
            receipt: null,
            result: JSON.stringify([{ number: 734, state }]),
          },
        ],
      },
    });
    const result = await developFeed();
    assert.deepEqual(
      result.picks.map((pick) => pick.id),
      state === "open" ? ["740"] : ["738", "740"],
    );
    assert.deepEqual(
      result.skipped,
      state === "open" ? [{ id: "738", reason: "waits for #734" }] : [],
    );
    assert.deepEqual(
      bridge.requests.map((request) => {
        assert.equal(request[0], "effect");
        return {
          method: request[1].method,
          payload: JSON.parse(request[1].payload) as unknown,
        };
      }),
      [
        {
          method: "issues",
          payload: { labels: ["cloving: ready"], state: "open", limit: 100 },
        },
        { method: "issue-states", payload: { numbers: [734] } },
      ],
    );
  }
}

export const feedTests = [
  {
    name: "CLV-363 developFeed selects #740 while #738 waits and selects #738 after its blocker closes",
    run: feedSelectionScenario,
  },
];

async function feedWithoutBlockers() {
  using bridge = fakeStepBridge({
    effects: {
      "github issues": [
        {
          kind: "completed",
          operationId: "ready",
          receipt: null,
          result: "[]",
        },
      ],
    },
  });
  assert.deepEqual(await developFeed(), { picks: [], skipped: [] });
  assert.equal(bridge.requests.length, 1);
}

async function feedBatchesBlockers() {
  const numbers = Array.from({ length: 51 }, (_, index) => index + 1);
  const issue = {
    ...ready[0],
    body: `## Dependencies\nNeeds ${numbers.map((number) => `#${String(number)}`).join(", ")}.`,
  };
  const results = [numbers.slice(0, 50), numbers.slice(50)].map((batch) => ({
    kind: "completed" as const,
    operationId: "states",
    receipt: null,
    result: JSON.stringify(
      batch.map((number) => ({ number, state: "closed" })),
    ),
  }));
  using bridge = fakeStepBridge({
    effects: {
      "github issues": [
        {
          kind: "completed",
          operationId: "ready",
          receipt: null,
          result: JSON.stringify([issue]),
        },
      ],
      "github issue-states": results,
    },
  });
  const result = await developFeed();
  assert.deepEqual(
    result.picks.map((pick) => pick.id),
    ["738"],
  );
  assert.deepEqual(
    bridge.requests.slice(1).map((request) => {
      assert.equal(request[0], "effect");
      return {
        payload: JSON.parse(request[1].payload) as unknown,
        round: request[1].scope.round,
      };
    }),
    [
      { payload: { numbers: numbers.slice(0, 50) }, round: 1 },
      { payload: { numbers: [51] }, round: 51 },
    ],
  );
}

async function feedReadFailure() {
  for (const method of ["issues", "issue-states"]) {
    using bridge = fakeStepBridge({
      effects: {
        "github issues": [
          {
            kind: "completed",
            operationId: "ready",
            receipt: null,
            result: JSON.stringify(ready),
          },
        ],
        [`github ${method}`]: [
          {
            kind: "failed",
            operationId: "failed",
            reason: "github-call-failed",
          },
        ],
      },
    });
    await assert.rejects(developFeed(), { message: "github-call-failed" });
    assert.equal(bridge.requests.length, method === "issues" ? 1 : 2);
  }
  using bridge = fakeStepBridge({
    effects: {
      "github issues": [
        {
          kind: "completed",
          operationId: "ready",
          receipt: null,
          result: null,
        },
      ],
    },
  });
  await assert.rejects(developFeed(), { message: "github-call-failed" });
  assert.equal(bridge.requests.length, 1);
}

feedTests.push(
  {
    name: "CLV-363 an empty feed does not read blocker states",
    run: feedWithoutBlockers,
  },
  {
    name: "CLV-363 the feed batches blocker reads with at most fifty numbers",
    run: feedBatchesBlockers,
  },
  {
    name: "CLV-363 failed feed reads do not return picks",
    run: feedReadFailure,
  },
);
