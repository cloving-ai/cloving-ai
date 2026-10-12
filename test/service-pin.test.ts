import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type {
  Delivery,
  DeliveryIntent,
} from "../src/broker/actor/authority.ts";
import {
  call,
  eventually,
  field,
  text,
  withHarness,
} from "./service-fixture.ts";
import { changedManifest } from "./service-views.ts";

function unreachableStarts(): Delivery {
  return {
    reconcile: () => Promise.reject(new Error("destination unreachable")),
    deliver: () => Promise.reject(new Error("destination unreachable")),
  };
}

async function shown(
  harness: Parameters<typeof call>[0],
  runId: string,
): Promise<readonly unknown[]> {
  const status = await call(harness, {
    operation: "status",
    parameters: { runId },
  });
  const run = field(status, "run");
  return [
    field(run, "workflowId"),
    field(run, "state"),
    field(field(run, "reason"), "code"),
    field(run, "nextAction"),
  ];
}

await test("CLV-049 a start in the queue is not sent when the installed workflow differs from the stored pin, and status gives the workflow ID of the stored request", () =>
  withHarness(async (harness) => {
    const first = await harness.start({ delivery: unreachableStarts() });
    const admitted = await call(harness, {
      operation: "run",
      parameters: {
        workflowId: "develop",
        source: "prompt",
        submission: { prompt: "the task" },
        commandId: "c-run",
      },
    });
    const runId = text(admitted, "runId");
    await eventually(async () =>
      (await shown(harness, runId))[2] === "delivery-outcome-unknown"
        ? true
        : undefined,
    );
    await first.close();
    const sent: DeliveryIntent[] = harness.sent;
    const changed = await harness.start({
      workflows: [{ ...harness.registration, manifest: changedManifest }],
    });
    await eventually(async () =>
      (await shown(harness, runId))[2] === "pinned-workflow-unavailable"
        ? true
        : undefined,
    );
    await delay(200);
    assert.equal(sent.length, 0);
    assert.deepEqual(await shown(harness, runId), [
      "develop",
      "queued",
      "pinned-workflow-unavailable",
      "restore-pinned-workflow",
    ]);
    await changed.close();
    const restored = await harness.start();
    await eventually(() => (sent.length === 1 ? true : undefined));
    assert.deepEqual(
      sent.map((intent) => intent.kind),
      ["start-run"],
    );
    assert.equal((await shown(harness, runId))[0], "develop");
    await restored.close();
  }));
