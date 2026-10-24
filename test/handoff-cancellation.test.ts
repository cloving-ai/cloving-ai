import assert from "node:assert/strict";
import { test } from "node:test";
import { handoffWorker } from "../src/daemon/handoff-worker.ts";
import { located, readRecord } from "../src/daemon/operation-journal.ts";
import {
  call,
  eventually,
  fakeRegistration,
  field,
  fields,
  startedRun,
  withHarness,
  type Harness,
} from "./service-fixture.ts";

import type { Delivery } from "../src/broker/actor/delivery-intents.ts";
import { view } from "./service-views.ts";

function deliveries(
  harness: Harness,
  parts: {
    readonly worker: ReturnType<typeof handoffWorker>;
    readonly settled: () => void;
  },
): Delivery {
  const { worker } = parts;
  return {
    deliver: (intent, signal) => {
      if (intent.kind === "protected-effect")
        return worker.deliver(intent, signal).finally(() => {
          parts.settled();
        });
      harness.sent.push(intent);
      return Promise.resolve({ receipt: `segment-${intent.runId}` });
    },
    reconcile: (intent, signal) =>
      intent.kind === "protected-effect"
        ? worker.reconcile(intent, signal)
        : Promise.resolve({ kind: "absent" }),
    stop: (intent, signal) =>
      intent.kind === "protected-effect"
        ? worker.stop(intent, signal)
        : Promise.resolve({
            kind: "stopped",
            receipt: `segment-${intent.runId}`,
          }),
  };
}

async function scene(harness: Harness) {
  const journal = harness.stateDirectory + "/handoffs";
  const resolved: unknown[] = [];
  const settled = Promise.withResolvers<undefined>();
  const worker = handoffWorker({
    journal,
    runtimeDirectory: harness.runtimeDirectory,
    retryMilliseconds: 100,
    document: () => Promise.resolve('{"prompt":"next"}'),
    runStatus: async (runId) =>
      String(field(await view(harness, runId), "state")),
  });
  const service = await harness.start({
    workflows: [
      {
        ...fakeRegistration([]),
        workflowId: "source",
        handoffs: ["develop"],
        effectLimit: 1,
      },
      { ...fakeRegistration(resolved), admission: "when-idle" },
    ],
    delivery: deliveries(harness, {
      worker,
      settled: () => {
        settled.resolve(undefined);
      },
    }),
  });

  return { journal, resolved, settled, service };
}

await test("CLV-182 cancelling the source during an active-target wait prevents a later target start", () =>
  withHarness(async (harness) => {
    const { journal, resolved, settled, service } = await scene(harness);
    const target = await startedRun(harness, { service, commandId: "active" });
    const source = await startedRun(harness, {
      service,
      commandId: "source",
      workflowId: "source",
    });
    const requested = await service.worker.requestEffect({
      runId: source,
      commandId: "handoff",
      scope: { phase: "handoff", operation: "handoff", round: 1 },
      capability: "handoff",
      method: "run",
      target: "develop",
      payload: '{"prompt":"next"}',
      units: 1,
    });
    assert.equal(requested.receipt.kind, "accepted");
    const operationId = requested.operation?.operationId;
    assert.ok(operationId);
    const folder = located(journal, operationId).folder;
    await eventually(
      async () => (await readRecord(folder, "attempts.json")) ?? undefined,
    );
    const cancelled = await call(harness, {
      operation: "run-command",
      parameters: {
        command: "drop",
        runId: source,
        commandId: "cancel",
        expectedRevision: 2,
      },
    });
    assert.equal(fields(cancelled["committed"])["state"], "cancelled");
    assert.equal(
      (
        await service.worker.completed({
          runId: target,
          commandId: "free-target",
          expectedRevision: 2,
        })
      ).kind,
      "accepted",
    );
    await settled.promise;
    assert.equal(resolved.length, 1);
    await service.close();
  }));
