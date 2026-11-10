import assert from "node:assert/strict";
import { test } from "node:test";
import { permitHoldOf, workspaceHold } from "../src/workspace-hold.ts";

const read = (name: string, busy: number) =>
  ({ kind: "read", name, busy, spentUsd: 0 }) as const;

const spent = (name: string, spentUsd: number) =>
  ({ kind: "read", name, busy: 0, spentUsd }) as const;

await test("CLV-312 the workspace holds a queue run when the active runs of all repositories and the open permits fill the workspace lanes", () => {
  assert.deepEqual(
    workspaceHold(
      { lanes: 2 },
      { members: [read("alpha", 2), read("beta", 0)], permits: 0 },
    ),
    {
      reason: "workspace-lanes",
      busy: 2,
      limit: 2,
      text: "Held: 2 of 2 workspace lanes busy",
    },
  );
  assert.equal(
    workspaceHold(
      { lanes: 2 },
      { members: [read("alpha", 1), read("beta", 0)], permits: 0 },
    ),
    undefined,
  );
  assert.equal(
    workspaceHold(
      { lanes: 2 },
      { members: [read("alpha", 1), read("beta", 0)], permits: 1 },
    )?.reason,
    "workspace-lanes",
  );
});

await test("CLV-312 the spend of all repositories counts toward the workspace daily spend limit, with a hold at 85 percent", () => {
  assert.deepEqual(
    workspaceHold(
      { dailySpendLimitUsd: 10 },
      { members: [spent("alpha", 5), spent("beta", 3.5)], permits: 0 },
    ),
    {
      reason: "workspace-spend",
      spentUsd: 8.5,
      limitUsd: 10,
      text: "Held: workspace spend 8.5 USD in 24 hours, 85 percent of the limit 10 USD",
    },
  );
  assert.equal(
    workspaceHold(
      { dailySpendLimitUsd: 10 },
      { members: [spent("alpha", 5), spent("beta", 3.4)], permits: 0 },
    ),
    undefined,
  );
});

await test("CLV-312 the workspace holds a queue run when it cannot read a repository, and admits every run with no workspace limits", () => {
  assert.deepEqual(
    workspaceHold(
      { lanes: 4 },
      {
        members: [
          read("alpha", 0),
          { kind: "unknown", name: "beta", detail: "service-unavailable" },
        ],
        permits: 0,
      },
    ),
    {
      reason: "workspace-unknown",
      text: "Held: the workspace cannot read beta: service-unavailable",
    },
  );
  assert.equal(
    workspaceHold(
      {},
      { members: [read("alpha", 9), spent("beta", 900)], permits: 3 },
    ),
    undefined,
  );
});

await test("CLV-312 a queue reads only a known workspace hold from the permit reply", () => {
  const hold = {
    reason: "workspace-lanes",
    busy: 2,
    limit: 2,
    text: "Held: 2 of 2 workspace lanes busy",
  };
  assert.deepEqual(permitHoldOf(hold), hold);
  assert.deepEqual(
    permitHoldOf({ reason: "workspace-unknown", text: "Held: x" }),
    { reason: "workspace-unknown", text: "Held: x" },
  );
  assert.deepEqual(
    permitHoldOf({
      reason: "workspace-spend",
      spentUsd: 9,
      limitUsd: 10,
      text: "Held: y",
    }),
    { reason: "workspace-spend", spentUsd: 9, limitUsd: 10, text: "Held: y" },
  );
  for (const value of [
    null,
    { reason: "load", text: "Held: z" },
    { reason: "workspace-lanes", text: 4 },
    { reason: "workspace-lanes", busy: "2", limit: 2, text: "Held" },
    { reason: "workspace-spend", spentUsd: 9, text: "Held" },
  ])
    assert.equal(permitHoldOf(value), undefined);
});
