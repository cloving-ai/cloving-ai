import assert from "node:assert/strict";
import { test } from "node:test";
import type { StoreReceipt } from "../src/broker/actor/authority.ts";
import { workerPort } from "../src/service/worker-port.ts";
import { openedAuthority } from "./authority-actor-fixture.ts";
import { temporaryDirectory } from "./authority-store-fixture.ts";

const accepted: StoreReceipt = { kind: "accepted", sequence: 7, intents: [] };
const request = {
  runId: "run-1",
  commandId: "c-request",
  scope: { phase: "work", operation: "effect", round: 1 },
  capability: "fake-harness",
  method: "run-turn",
  target: "workspace/main",
  payload: "build the package",
  units: 1,
};
const report = {
  runId: "run-1",
  commandId: "c-report",
  operationId: "operation-1",
  inputDigest: "sha256:input",
  leaseGeneration: 1,
  worker: "worker-1",
  outcome: "completed",
  result: "done",
};

async function port(): Promise<{
  readonly sent: unknown[];
  readonly worker: ReturnType<typeof workerPort>;
}> {
  const authority = await openedAuthority(await temporaryDirectory());
  await authority.close();
  const sent: unknown[] = [];
  return {
    sent,
    worker: workerPort({
      authority,
      gateway: {
        execute: (submission) => {
          sent.push(submission.command["kind"]);
          return Promise.resolve(accepted);
        },
      },
    }),
  };
}

await test("CLV-059 the worker port gives a reply with the receipt, and no error, for a command that the authority accepted before it failed closed", async () => {
  const { sent, worker } = await port();
  const unread = { receipt: accepted, disposition: null, operation: null };
  assert.deepEqual(await worker.requestEffect(request), unread);
  assert.deepEqual(
    await worker.reportEffect({ ...report, outcome: "completed" }),
    unread,
  );
  assert.deepEqual(sent, ["request-effect", "report-effect"]);
});

await test("CLV-059 the worker port rejects a payload, a result or an operation ID that is not a text with invalid-command", async () => {
  const { sent, worker } = await port();
  const invalid = {
    receipt: { kind: "rejected", reason: "invalid-command" },
    disposition: null,
    operation: null,
  };
  const replies: unknown[] = [
    await Reflect.apply(worker.requestEffect, undefined, [
      { ...request, payload: 5 },
    ]),
    await Reflect.apply(worker.reportEffect, undefined, [
      { ...report, result: 5 },
    ]),
    await Reflect.apply(worker.reportEffect, undefined, [
      { ...report, operationId: 5 },
    ]),
  ];
  assert.deepEqual(replies, [invalid, invalid, invalid]);
  assert.deepEqual(sent, []);
});
