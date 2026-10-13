import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorldRun } from "../src/authority/reconciliation.ts";
import { reconcileWorld } from "../src/host/world-reconciliation.ts";
import type { HostPorts, Service } from "../src/service/service.ts";
import {
  call,
  field,
  fields,
  startedRun,
  waitingGate,
  withHarness,
  type Harness,
} from "./service-fixture.ts";

async function shown(harness: Harness, runId: string): Promise<unknown> {
  const reply = await call(harness, {
    operation: "status",
    parameters: { runId },
  });
  const run = fields(field(reply, "run"));
  return {
    state: run["state"],
    condition: run["condition"],
    reason: fields(run["reason"]),
    evidence: run["evidence"],
    nextAction: run["nextAction"],
    humanInputCanHelp: run["humanInputCanHelp"],
  };
}

function ended(expected: {
  readonly state: string;
  readonly code: string;
  readonly detail: string;
  readonly evidence: readonly string[];
  readonly nextAction: string | null;
}): unknown {
  const { state, code, detail, evidence, nextAction } = expected;
  return {
    state,
    condition: state,
    reason: { code, detail },
    evidence,
    nextAction,
    humanInputCanHelp: true,
  };
}

const failedDetail = "The SDK run of this run failed in the World.";
const cancelledDetail =
  "The SDK run of this run was cancelled in the World. Cloving did not ask for that.";

interface Scene {
  readonly service: Service;
  readonly world: WorldRun[];
  readonly pass: () => Promise<void>;
}

async function scene(harness: Harness): Promise<Scene> {
  const captured: HostPorts[] = [];
  const reports: unknown[] = [];
  const service = await harness.start({
    host: (ports) => {
      captured.push(ports);
      return Promise.resolve({
        close: () => Promise.resolve(),
        reports: () => reports,
      });
    },
  });
  const [ports] = captured;
  assert.ok(ports);
  const world: WorldRun[] = [];
  return {
    service,
    world,
    pass: async () => {
      const result = await reconcileWorld({
        state: ports.state,
        submit: ports.submit,
        runs: () => Promise.resolve(world),
        outcome: () => Promise.resolve("waiting_for_decision"),
      });
      reports.splice(0, reports.length, ...result.reports);
    },
  };
}

await test("CLV-056 status shows the reason, the evidence and the next action of each World outcome", () =>
  withHarness(async (harness) => {
    const { service, world, pass } = await scene(harness);
    const failed = await startedRun(harness, { service, commandId: "c-a" });
    world.push({ runId: failed, receipt: "wrun-1", status: "failed" });
    await pass();
    assert.deepEqual(
      await shown(harness, failed),
      ended({
        state: "failed",
        code: "world-run-failed",
        detail: failedDetail,
        evidence: ["event:4", "world-run:wrun-1"],
        nextAction: null,
      }),
    );
    const waiting = await waitingGate(harness, {
      service,
      commandId: "c-c",
      kind: "question",
    });
    world.push({
      runId: waiting.runId,
      receipt: "wrun-2",
      status: "completed",
    });
    world.push({ runId: "run-unknown", receipt: "wrun-9", status: "running" });
    await pass();
    assert.partialDeepStrictEqual(await shown(harness, waiting.runId), {
      state: "waiting_gate",
      reason: { code: "design-question" },
      nextAction: "answer",
    });
    const list = await call(harness, { operation: "status", parameters: {} });
    assert.deepEqual(field(list, "worldReports"), [
      { kind: "unknown-world-run", runId: "run-unknown", receipt: "wrun-9" },
    ]);
    await service.close();
  }));

await test("CLV-056 status shows a World cancellation of a paused run as a recovery state with the next action resume, and as a failure after the resume", () =>
  withHarness(async (harness) => {
    const { service, world, pass } = await scene(harness);
    const paused = await startedRun(harness, { service, commandId: "c-b" });
    const command = (name: string, revision: number): Promise<unknown> =>
      call(harness, {
        operation: "run-command",
        parameters: {
          command: name,
          runId: paused,
          expectedRevision: revision,
          commandId: `c-b-${name}`,
        },
      });
    await command("pause", 2);
    world.push({ runId: paused, receipt: "wrun-1", status: "cancelled" });
    await pass();
    await pass();
    const cancelled = {
      code: "world-run-cancelled",
      detail: cancelledDetail,
      evidence: ["event:5", "world-run:wrun-1"],
    };
    assert.deepEqual(
      await shown(harness, paused),
      ended({ ...cancelled, state: "paused", nextAction: "resume" }),
    );
    await command("resume", 3);
    await pass();
    assert.deepEqual(
      await shown(harness, paused),
      ended({ ...cancelled, state: "failed", nextAction: null }),
    );
    await service.close();
  }));
