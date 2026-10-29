import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeStepBridge } from "cloving/workflows/testing";
import { ideaToIssue } from "./idea-to-issue.ts";
import {
  input,
  text,
  digest,
  effects,
  selection,
  effectPayloads,
  readyLabel,
} from "./idea-to-issue/scenarios.ts";

await test("CLV-222 the selected complete configuration posts and delivers the issue", async () => {
  using bridge = fakeStepBridge({
    effects: effects(),
    decisions: [
      { decision: "approved", answer: null },
      { decision: "approved", answer: null },
    ],
    effectLimit: 9,
  });
  assert.deepEqual(await ideaToIssue(input), {
    kind: "handoff_requested",
    cycleId: input.cycleId,
    promotionId: "issue-42",
  });
  const humanCount =
    Number(selection.review === "person") + Number(selection.post === "person");
  const gates = bridge.requests.filter(
    (request) => request[0] === "waitForDecision",
  );
  assert.equal(gates.length, humanCount);
  for (const gate of gates) assert.ok(gate[1].prompt.includes(text));
  const post = bridge.requests.find(
    (request) =>
      request[0] === "effect" && request[1].method === "create-issue",
  );
  assert.ok(post && post[0] === "effect");
  assert.deepEqual(JSON.parse(post[1].payload), {
    draft: "cloving-prd-draft.md",
    ...(humanCount === 0
      ? {}
      : { expectedDigests: Array.from({ length: humanCount }, () => digest) }),
  });
  assert.equal(
    bridge.requests.filter((request) => request[0] === "handoff").length,
    Number(selection.next === "develop"),
  );
  assert.deepEqual(
    effectPayloads(bridge.requests, "label"),
    selection.next === "queue" ? [readyLabel] : [],
  );
});

await test("CLV-222 a refused post preserves the draft and stops delivery", async () => {
  using bridge = fakeStepBridge({
    effects: {
      ...effects(),
      "github create-issue": [
        { kind: "failed", operationId: "post", reason: "draft-changed" },
      ],
    },
    decisions: [
      { decision: "approved", answer: null },
      { decision: "approved", answer: null },
    ],
  });
  assert.deepEqual(await ideaToIssue(input), {
    kind: "blocked",
    evidenceId: "idea-to-issue",
    cycleId: input.cycleId,
    reason: "draft-changed",
  });
  assert.ok(bridge.requests.every((request) => request[0] !== "handoff"));
  const last = bridge.requests.at(-1);
  assert.ok(last && last[0] === "effect" && last[1].method === "create-issue");
});
