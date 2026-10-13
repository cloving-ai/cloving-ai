import assert from "node:assert/strict";
import { test } from "node:test";
import { stepBridge } from "../src/host/step-bridge-host.ts";
import type { HostPorts } from "../src/service/service.ts";
import {
  call,
  field,
  fields,
  startedRun,
  withHarness,
} from "./service-fixture.ts";

const request = {
  scope: { phase: "work", operation: "effect", round: 1 },
  capability: "fake-harness",
  method: "run-turn",
  target: "workspace/main",
  payload: "build the package",
  units: 1,
};

await test("CLV-059 a host of an older epoch cannot commit a result or request a protected effect", () =>
  withHarness(async (harness) => {
    const first = await harness.start();
    const older = first.epoch;
    await first.close();
    const captured: HostPorts[] = [];
    const service = await harness.start({
      host: (ports) => {
        captured.push(ports);
        return Promise.resolve({ close: () => Promise.resolve() });
      },
    });
    const [ports] = captured;
    assert.ok(ports);
    assert.equal(service.epoch > older, true);
    const runId = await startedRun(harness, { service, commandId: "c-1" });
    const stale = stepBridge({
      ...ports,
      call: () => ({ worldRunId: "wrun-1", stepId: "step-1", attempt: 1 }),
      run: () => Promise.resolve({ runId }),
      stopped: new AbortController().signal,
      requestEffect: (asked) => ports.requestEffect({ ...asked, epoch: older }),
    });
    assert.deepEqual(await stale.effect(request), {
      kind: "refused",
      reason: "stale-epoch",
    });
    const report = await service.worker.reportEffect({
      runId,
      commandId: "c-report",
      operationId: `["cloving-operation",1,${JSON.stringify(runId)},"work","effect",null,null]`,
      inputDigest: `sha256:${"0".repeat(64)}`,
      leaseGeneration: 1,
      worker: "worker-1",
      outcome: "completed",
      result: "a late result",
      epoch: older,
    });
    assert.deepEqual(
      [report.receipt.kind, field(report.receipt, "reason")],
      ["rejected", "stale-epoch"],
    );
    const run = fields(
      field(
        await call(harness, { operation: "status", parameters: { runId } }),
        "run",
      ),
    );
    assert.deepEqual([run["effects"], run["budget"]], [[], null]);
    assert.equal(
      harness.sent.filter((intent) => intent.kind === "protected-effect")
        .length,
      0,
    );
    await service.close();
  }));
