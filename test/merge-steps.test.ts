import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { fakeStepBridge, runScenario } from "../src/testing.ts";
import { mergeByPerson } from "../src/steps/merge-by-person.ts";
import { mergeWhenGreen } from "../src/steps/merge-when-green.ts";
import { withFiles } from "./quality/files-fixture.ts";

const commit = "b".repeat(40);
const pull = {
  number: 42,
  url: "https://github.com/owner/repository/pull/42",
  commit,
  target: "ticket-1",
};

function merged(result: Readonly<Record<string, string | number>>) {
  return {
    kind: "completed" as const,
    operationId: "merge",
    receipt: null,
    result: JSON.stringify(result),
  };
}

const done = merged({
  number: 42,
  commit,
  updated: "c".repeat(40),
  merged: "d".repeat(40),
});

await test("CLV-220 mergeWhenGreen merges through one GitHub merge effect for the pull target", async () => {
  using bridge = fakeStepBridge({ effects: { "github merge": [done] } });
  const result = await mergeWhenGreen({ pull, check: "beforeMerge" });
  assert.deepEqual(result, { merged: true, reason: null, output: "" });
  assert.equal(bridge.requests.length, 1);
  const request = bridge.requests[0];
  assert.ok(request?.[0] === "effect");
  assert.equal(request[1].capability, "github");
  assert.equal(request[1].method, "merge");
  assert.equal(request[1].target, "ticket-1");
  assert.equal(request[1].units, 1);
  assert.deepEqual(JSON.parse(request[1].payload), {
    number: 42,
    commit,
    check: "beforeMerge",
  });
});

await test("CLV-220 mergeWhenGreen sends a null check as written", async () => {
  using bridge = fakeStepBridge({ effects: { "github merge": [done] } });
  await mergeWhenGreen({ pull, check: null });
  const request = bridge.requests[0];
  assert.ok(request?.[0] === "effect");
  assert.deepEqual(JSON.parse(request[1].payload), {
    number: 42,
    commit,
    check: null,
  });
});

for (const reason of [
  "check-failed",
  "merge-conflict",
  "ci-failed",
  "ci-pending",
] as const)
  await test(`CLV-220 mergeWhenGreen returns ${reason} with its output and no merge`, async () => {
    using bridge = fakeStepBridge({
      effects: {
        "github merge": [merged({ reason, output: "Test 3 failed." })],
      },
    });
    assert.deepEqual(await mergeWhenGreen({ pull, check: "beforeMerge" }), {
      merged: false,
      reason,
      output: "Test 3 failed.",
    });
    assert.equal(bridge.requests.length, 1);
  });

await test("CLV-220 mergeWhenGreen returns check-not-configured and throws other failures", async () => {
  const failed = (reason: string) => ({
    kind: "failed" as const,
    operationId: "merge",
    reason,
  });
  {
    using bridge = fakeStepBridge({
      effects: { "github merge": [failed("check-not-configured")] },
    });
    assert.deepEqual(await mergeWhenGreen({ pull, check: "beforeMerge" }), {
      merged: false,
      reason: "check-not-configured",
      output: "",
    });
    assert.equal(bridge.requests.length, 1);
  }
  using bridge = fakeStepBridge({
    effects: { "github merge": [failed("github-call-failed")] },
  });
  await assert.rejects(
    mergeWhenGreen({ pull, check: null }),
    /github-call-failed/,
  );
  assert.equal(bridge.requests.length, 1);
});

await test("CLV-220 mergeByPerson merges only after an approval of the pull commit", async () => {
  using bridge = fakeStepBridge({
    effects: { "github merge": [done] },
    decisions: [{ decision: "approved", answer: null }],
  });
  const result = await mergeByPerson({ pull, check: null });
  assert.deepEqual(result, { merged: true, reason: null, output: "" });
  const [gate, effect] = bridge.requests;
  assert.ok(gate?.[0] === "waitForDecision");
  assert.equal(gate[1].gateId, `merge:42:${commit}`);
  assert.equal(gate[1].kind, "approval");
  assert.match(gate[1].prompt, /#42/);
  assert.ok(effect?.[0] === "effect");
  assert.deepEqual(JSON.parse(effect[1].payload), {
    number: 42,
    commit,
    check: null,
  });
});

await test("CLV-220 mergeByPerson returns not-approved with the answer and starts no merge", async () => {
  using bridge = fakeStepBridge({
    decisions: [{ decision: "denied", answer: "Not before the release." }],
  });
  assert.deepEqual(await mergeByPerson({ pull, check: "beforeMerge" }), {
    merged: false,
    reason: "not-approved",
    output: "Not before the release.",
  });
  assert.deepEqual(
    bridge.requests.map(([kind]) => kind),
    ["waitForDecision"],
  );
});

await test("CLV-220 a merge retry with a new round starts a new merge operation", async () => {
  using bridge = fakeStepBridge({
    effects: {
      "github merge": [merged({ reason: "ci-pending", output: "" }), done],
    },
    decisions: [{ decision: "approved", answer: null }],
  });
  const first = await mergeWhenGreen({ pull, check: null });
  const second = await mergeByPerson({ pull, check: null, round: 2 });
  assert.equal(first.reason, "ci-pending");
  assert.equal(second.merged, true);
  const scopes = bridge.requests.flatMap((request) =>
    request[0] === "effect" ? [request[1].scope] : [],
  );
  assert.deepEqual(
    scopes.map((scope) => [scope.round, scope.key]),
    [
      [1, `42:${commit}`],
      [2, `42:${commit}`],
    ],
  );
});

for (const result of [
  "{",
  null,
  "[]",
  JSON.stringify({ reason: "unknown", output: "" }),
  JSON.stringify({ reason: "check-failed" }),
  JSON.stringify({ number: 43, commit, merged: "d".repeat(40) }),
  JSON.stringify({ number: 42, commit: "e".repeat(40), merged: "d" }),
  JSON.stringify({ number: 42, commit }),
])
  await test(`CLV-220 mergeWhenGreen rejects a malformed merge result ${String(result)}`, async () => {
    using bridge = fakeStepBridge({
      effects: {
        "github merge": [
          { kind: "completed", operationId: "merge", receipt: null, result },
        ],
      },
    });
    await assert.rejects(
      mergeWhenGreen({ pull, check: null }),
      /invalid-merge-result/,
    );
    assert.equal(bridge.requests.length, 1);
  });

for (const decision of [
  { decision: "denied", answer: null },
  { decision: "expired", answer: null },
] as const)
  await test(`CLV-220 mergeByPerson gives an empty output when the ${decision.decision} decision has no answer`, async () => {
    using bridge = fakeStepBridge({ decisions: [decision] });
    assert.deepEqual(await mergeByPerson({ pull, check: null }), {
      merged: false,
      reason: "not-approved",
      output: "",
    });
    assert.equal(bridge.requests.length, 1);
  });

for (const request of [
  { pull },
  { pull: { ...pull, number: 0 }, check: null },
  { pull: { ...pull, commit: "main" }, check: null },
  { pull: { ...pull, target: "" }, check: null },
  { pull, check: "afterMerge" },
  { pull, check: null, round: 0 },
  { pull, check: null, round: 1.5 },
  { pull, check: null, round: "2" },
])
  await test(`CLV-220 merge steps refuse an invalid request ${JSON.stringify(request)}`, async () => {
    using bridge = fakeStepBridge({});
    for (const step of [mergeWhenGreen, mergeByPerson]) {
      const pending: unknown = Reflect.apply(step, undefined, [request]);
      await assert.rejects(Promise.resolve(pending), /invalid-merge-request/);
    }
    assert.deepEqual(bridge.requests, []);
  });

await test("CLV-220 a workflow imports both merge steps and runs them with the fake step bridge", () =>
  withFiles(
    {
      "merge.mjs": `import { mergeByPerson } from "cloving/workflows/steps/merge-by-person";
import { mergeWhenGreen } from "cloving/workflows/steps/merge-when-green";
export async function merge(pull) {
  const person = await mergeByPerson({ pull, check: null });
  return { person, green: await mergeWhenGreen({ pull, check: "beforeMerge" }) };
}`,
    },
    async (root) => {
      const result = await runScenario({
        workflow: join(root, "merge.mjs"),
        exportName: "merge",
        input: pull,
        decisions: [{ decision: "denied", answer: "Wait." }],
        effects: { "github merge": [done] },
      });
      assert.deepEqual(result.outcome, {
        person: { merged: false, reason: "not-approved", output: "Wait." },
        green: { merged: true, reason: null, output: "" },
      });
    },
  ));
