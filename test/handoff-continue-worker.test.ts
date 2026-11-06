import assert from "node:assert/strict";
import { test } from "node:test";
import { handoffWorker } from "../src/daemon/handoff-worker.ts";
import type { Reply, ServiceRequest } from "../src/protocol.ts";
import { runIdentity } from "../src/service/submission-handler.ts";
import { listen } from "../src/service/transport.ts";
import { intent, settings } from "./handoff-worker-fixture.ts";
import { withHarness, type Harness } from "./service-fixture.ts";

const continuation = { ...intent, method: "continue", target: "run-child" };
const commandId = `continue:${intent.operationId}`;
const payload = '{"from":"merge/merge","bundle":"current"}';

async function answering(
  harness: Harness,
  answer: (request: ServiceRequest) => Reply,
): Promise<ServiceRequest[]> {
  const requests: ServiceRequest[] = [];
  const listener = await listen({
    path: harness.runtimeDirectory + "/control.sock",
    handle: (request) => {
      requests.push(request);
      return Promise.resolve(answer(request));
    },
  });
  harness.cleanup(listener.close);
  return requests;
}

function worker(harness: Harness) {
  return handoffWorker({
    ...settings(harness),
    document: () => Promise.resolve(payload),
  });
}

await test("CLV-307 a continuation effect asks the service to continue the run once and returns the new run ID", () =>
  withHarness(async (harness) => {
    const requests = await answering(harness, () => ({
      kind: "result",
      result: { kind: "run-continued", runId: "run-next" },
    }));
    const signal = new AbortController().signal;
    const completed = {
      kind: "completed",
      worker: "handoff",
      receipt: "run-next",
      result: "run-next",
    };
    assert.deepEqual(
      await worker(harness).deliver(continuation, signal),
      completed,
    );
    assert.deepEqual(
      await worker(harness).deliver(continuation, signal),
      completed,
    );
    assert.deepEqual(requests, [
      {
        operation: "continue-run",
        parameters: {
          runId: "run-child",
          commandId,
          from: "merge/merge",
          bundle: "current",
        },
      },
    ]);
  }));

await test("CLV-307 a refused continuation fails with the refusal code and an uncertain reply stays unknown", () =>
  withHarness(async (harness) => {
    let code = "continuation-outside-chain";
    await answering(harness, () => ({
      kind: "error",
      error: { code, detail: "refused" },
    }));
    const signal = new AbortController().signal;
    assert.deepEqual(await worker(harness).deliver(continuation, signal), {
      kind: "failed",
      reason: "continuation-outside-chain",
    });
    code = "service-busy";
    assert.deepEqual(
      await worker(harness).deliver(
        { ...continuation, operationId: `${intent.operationId}-busy` },
        signal,
      ),
      { kind: "unknown" },
    );
  }));

await test("CLV-307 reconciliation finds the continuation run by its command ID and starts no run", () =>
  withHarness(async (harness) => {
    const requests = await answering(harness, (request) =>
      request.operation === "status"
        ? { kind: "result", result: { run: { runId: "run-next" } } }
        : { kind: "error", error: { code: "unexpected", detail: "" } },
    );
    const signal = new AbortController().signal;
    assert.equal(
      (await worker(harness).reconcile(continuation, signal)).kind,
      "completed",
    );
    assert.deepEqual(requests, [
      {
        operation: "status",
        parameters: { runId: runIdentity(commandId) },
      },
    ]);
  }));
