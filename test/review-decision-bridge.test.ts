import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { stepBridge, type BridgePorts } from "../src/host/step-bridge-host.ts";

const request = {
  gateId: "review",
  kind: "approval",
  prompt: "Review the exact draft.",
} as const;
const subject =
  "sha256:" + createHash("sha256").update(request.prompt).digest("hex");
const recorded = {
  kind: "approval",
  wait: "hook",
  subject,
  outcome: { decision: "denied", answer: "sha256:feedback" },
};

function ports(gate: unknown): BridgePorts {
  return {
    call: () => ({ worldRunId: "world", stepId: "step", attempt: 1 }),
    run: () => Promise.resolve({ runId: "run" }),
    stopped: new AbortController().signal,
    state: () =>
      Promise.resolve({
        runs: { run: { status: "running", revision: 4 } },
        gates: { "run review": gate },
      }),
    document: () => Promise.resolve("Keep the first draft."),
    decisionReceived: () => Promise.resolve(true),
    openGate: () => Promise.reject(new Error("No new gate should open.")),
    registerWait: () =>
      Promise.reject(new Error("No legacy wait should open.")),
    requestEffect: () =>
      Promise.reject(new Error("No protected effect should run.")),
    operation: () => Promise.resolve(undefined),
  };
}

await test("CLV-220 an existing subject returns its stored decision and feedback without another hook", async () => {
  const wait = stepBridge(ports(recorded)).waitForDecision;
  assert.ok(wait);
  assert.deepEqual(await wait(request), {
    decision: "denied",
    answer: "Keep the first draft.",
  });
});

await test("CLV-220 a gate with another subject or decision mode cannot supply a review", async () => {
  for (const gate of [
    { ...recorded, subject: "sha256:other" },
    { ...recorded, kind: "question" },
    { ...recorded, wait: "registered" },
  ]) {
    const wait = stepBridge(ports(gate)).waitForDecision;
    assert.ok(wait);
    await assert.rejects(wait(request), { message: "gate-subject-changed" });
  }
});

await test("CLV-220 an approved gate without a received hook still returns its original token", async () => {
  const wait = stepBridge({
    ...ports({ ...recorded, outcome: { decision: "approved", answer: null } }),
    decisionReceived: () => Promise.resolve(false),
  }).waitForDecision;
  assert.ok(wait);
  assert.deepEqual(await wait(request), {
    token: "cloving-decision/v1/run/review",
  });
});
