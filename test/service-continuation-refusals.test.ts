import assert from "node:assert/strict";
import { test } from "node:test";
import { servicePrelude, withConsumer } from "./world-host-fixture.ts";

const workflows = `
import { protectedEffect } from "cloving/workflows/steps/protected-effect";

const step = (scope, payload) =>
  protectedEffect({ scope, capability: "fake-harness", method: "run-turn", target: "workspace/main", payload, units: 1 });

export async function develop(input: { cycleId: string }) {
  "use workflow";
  await step({ phase: "implement", operation: "claude-turn", round: 1 }, "turn");
  const merge = await step({ phase: "merge", operation: "merge", round: 1 }, "merge");
  if (merge.kind !== "completed") throw new Error(merge.reason ?? merge.kind);
  if (merge.result !== "merge-conflict") return { kind: "handoff_requested", cycleId: input.cycleId, promotionId: "pull-request-1" };
  const repair = await step({ phase: "implement", operation: "claude-turn", round: 2 }, "repair");
  if (repair.result === "blocked") return { kind: "blocked", cycleId: input.cycleId, reason: "merge-conflict", evidenceId: "e-1" };
  await step({ phase: "merge", operation: "merge", round: 2 }, "merge again");
  return { kind: "handoff_requested", cycleId: input.cycleId, promotionId: "pull-request-1" };
}
`;

const scene = `${servicePrelude}
const scoped = (intent) => JSON.parse(intent.operationId);
const scripted = {
  ...destination,
  deliver: async (intent) => {
    const [, round, , , operation] = scoped(intent);
    appendFileSync("sent.log", operation + "/" + round + "\\n");
    if (existsSync("fail-merge") && operation === "merge") return { kind: "failed", reason: "git-call-failed", receipt: null, worker: null };
    const sent = await destination.deliver(intent);
    if (operation === "merge" && round === 1 && existsSync("conflict")) return { ...sent, result: "merge-conflict" };
    if (operation === "claude-turn" && round === 2 && existsSync("block")) return { ...sent, result: "blocked" };
    return sent;
  },
};
const ended = async (runId) => { await until(async () => ["completed", "failed", "cancelled"].includes(await stateOf(runId))); return (await asked("status", { runId })).run; };
const continued = (parameters) => asked("continue-run", { commandId: "c-continue", ...parameters });
const refusal = (reply) => [reply.kind, reply.error?.code ?? reply.code];
`;

await test("CLV-307 a run that completed blocked after a merge conflict continues from the conflict repair step", () =>
  withConsumer(workflows, async (consumer) => {
    const result = await consumer.run(`${scene}
writeFileSync("conflict", "");
writeFileSync("block", "");
const service = await hosted({ destination: scripted });
const runId = await submitted("c-1");
const before = await ended(runId);
rmSync("block");
const reply = await continued({ runId, from: "implement/claude-turn/2" });
const after = await ended(reply.runId);
print({ before: [before.state, before.outcome?.kind], after: [after.state, after.outcome?.kind], sent: lines("sent.log") });
await service.close();
`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lines[0], {
      before: ["completed", "blocked"],
      after: ["completed", "handoff_requested"],
      sent: [
        "claude-turn/1",
        "merge/1",
        "claude-turn/2",
        "claude-turn/2",
        "merge/2",
      ],
    });
  }));

await test("CLV-307 a continuation without the retained bundle is refused, and the current workflow continues it", () =>
  withConsumer(workflows, async (consumer) => {
    const result = await consumer.run(`${scene}
writeFileSync("fail-merge", "");
const first = await hosted({ destination: scripted });
const runId = await submitted("c-1");
await ended(runId);
await first.close();
rmSync("fail-merge");
const registration = fakeRegistration([]);
const changed = { ...registration, effectLimit: 5, manifest: { ...registration.manifest, resources: { "prompts/implement.md": "f".repeat(64) } } };
const service = await hosted({ destination: scripted, registrations: [changed] });
const retained = await continued({ runId });
const current = await continued({ runId, bundle: "current", commandId: "c-continue-current" });
const after = current.kind === "run-continued" ? await ended(current.runId) : { state: refusal(current) };
print({ retained: refusal(retained), after: after.state, sent: lines("sent.log") });
await service.close();
`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lines[0], {
      retained: ["error", "pinned-workflow-unavailable"],
      after: "completed",
      sent: ["claude-turn/1", "merge/1", "merge/1"],
    });
  }));

await test("CLV-307 the service refuses a continuation of a dropped run, of a run that completed with a handoff, and of a run that has a continuation", () =>
  withConsumer(workflows, async (consumer) => {
    const result = await consumer.run(`${scene}
writeFileSync("fail-merge", "");
writeFileSync("hold-effect", "");
const service = await hosted({ destination: scripted });
const dropped = await submitted("c-drop");
await until(async () => lines("sent.log").length > 0);
await asked("run-command", { command: "drop", runId: dropped, expectedRevision: (await asked("status", { runId: dropped })).run.revision, commandId: "c-dropped" });
rmSync("hold-effect");
await ended(dropped);
const failed = await submitted("c-fail");
await ended(failed);
rmSync("fail-merge");
const first = await continued({ runId: failed });
const handedOff = await ended(first.runId);
const second = await continued({ runId: failed, commandId: "c-continue-2" });
const finished = await continued({ runId: first.runId, commandId: "c-continue-3" });
const droppedReply = await continued({ runId: dropped, commandId: "c-continue-4" });
print({ outcome: handedOff.outcome?.kind, second: refusal(second), finished: refusal(finished), cancelled: refusal(droppedReply), continuedBy: (await asked("status", { runId: failed })).run.continuedBy === first.runId, continuedFrom: handedOff.continuedFrom === failed });
await service.close();
`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lines[0], {
      outcome: "handoff_requested",
      second: ["error", "run-already-continued"],
      finished: ["error", "run-not-blocked"],
      cancelled: ["error", "run-cancelled"],
      continuedBy: true,
      continuedFrom: true,
    });
  }));
