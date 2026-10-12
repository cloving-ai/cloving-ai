import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Delivery,
  DeliveryIntent,
} from "../src/broker/actor/authority.ts";
import {
  admitted,
  call,
  decide,
  digestOf,
  eventually,
  field,
  waitingGate,
  withHarness,
  type Harness,
} from "./service-fixture.ts";

function stoppable(
  harness: Harness,
  stop: NonNullable<Delivery["stop"]>,
): { readonly delivery: Delivery; readonly stopped: DeliveryIntent[] } {
  const stopped: DeliveryIntent[] = [];
  return {
    stopped,
    delivery: {
      reconcile: (intent) =>
        Promise.resolve(
          harness.sent.some((sent) => sent.operationId === intent.operationId)
            ? { kind: "accepted", receipt: "wrun-1" }
            : { kind: "absent" },
        ),
      deliver: (intent) => {
        harness.sent.push(intent);
        return Promise.resolve({ receipt: "wrun-1" });
      },
      stop: (intent, signal) => {
        stopped.push(intent);
        return stop(intent, signal);
      },
    },
  };
}

async function shown(
  harness: Harness,
  runId: string,
): Promise<readonly unknown[]> {
  const status = await call(harness, {
    operation: "status",
    parameters: { runId },
  });
  const run = field(status, "run");
  return [
    field(run, "state"),
    field(run, "condition"),
    field(field(run, "reason"), "code"),
    field(run, "nextAction"),
    field(run, "humanInputCanHelp"),
  ];
}

function dropped(harness: Harness, runId: string): Promise<unknown> {
  return call(harness, {
    operation: "run-command",
    parameters: {
      command: "drop",
      runId,
      expectedRevision: 1,
      commandId: "c-drop",
    },
  });
}

await test("CLV-049 a drop of a run with a sent start sends one stop request, and status shows cancelled after the confirmed stop", () =>
  withHarness(async (harness) => {
    const adapter = stoppable(harness, () =>
      Promise.resolve({ kind: "stopped" }),
    );
    const service = await harness.start({ delivery: adapter.delivery });
    const runId = await admitted(harness, "c-1");
    await dropped(harness, runId);
    await eventually(async () =>
      (await shown(harness, runId))[1] === "cancelled" ? true : undefined,
    );
    assert.deepEqual(await shown(harness, runId), [
      "cancelled",
      "cancelled",
      "run-cancelled",
      null,
      false,
    ]);
    assert.deepEqual(
      adapter.stopped.map((intent) => [intent.kind, intent.purpose]),
      [["start-run", "stop"]],
    );
    assert.equal(harness.sent.length, 1);
    await service.close();
  }));

await test("CLV-049 a drop with a lost stop reply shows an uncertain stop in status, sends no new dispatch and claims no terminal cancellation", () =>
  withHarness(async (harness) => {
    const adapter = stoppable(harness, () =>
      Promise.reject(new Error("the stop reply is lost")),
    );
    const service = await harness.start({ delivery: adapter.delivery });
    const runId = await admitted(harness, "c-1");
    await dropped(harness, runId);
    await eventually(async () =>
      (await shown(harness, runId))[2] === "stop-unconfirmed"
        ? true
        : undefined,
    );
    assert.deepEqual(await shown(harness, runId), [
      "cancelled",
      "cancelling",
      "stop-unconfirmed",
      "confirm-worker-stop",
      true,
    ]);
    assert.equal(adapter.stopped.length, 3);
    assert.equal(harness.sent.length, 1);
    await service.close();
  }));

await test("CLV-049 a drop of a run with a sent start and a sent continuation sends one stop request for each of them, and status shows cancelled after the two confirmed stops", () =>
  withHarness(async (harness) => {
    const adapter = stoppable(harness, () =>
      Promise.resolve({ kind: "stopped" }),
    );
    const service = await harness.start({ delivery: adapter.delivery });
    const waiting = await waitingGate(harness, {
      service,
      commandId: "c-1",
      kind: "approval",
    });
    await decide(harness, {
      command: "approve",
      reference: waiting.decisionId,
      subjectDigest: digestOf("approval of c-1?"),
    });
    await eventually(() => (harness.sent.length === 2 ? true : undefined));
    const status = await call(harness, {
      operation: "status",
      parameters: { runId: waiting.runId },
    });
    await call(harness, {
      operation: "run-command",
      parameters: {
        command: "drop",
        runId: waiting.runId,
        expectedRevision: field(field(status, "run"), "revision"),
        commandId: "c-drop",
      },
    });
    await eventually(async () =>
      (await shown(harness, waiting.runId))[1] === "cancelled"
        ? true
        : undefined,
    );
    assert.deepEqual(
      adapter.stopped.map((intent) => [intent.kind, intent.purpose]).sort(),
      [
        ["continue-run", "stop"],
        ["start-run", "stop"],
      ],
    );
    assert.equal(harness.sent.length, 2);
    await service.close();
  }));
