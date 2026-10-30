import assert from "node:assert/strict";
import type { HostPorts, ServiceOptions } from "../src/service/service.ts";
import type { Harness } from "./service-fixture.ts";
import { call, field, fields, text } from "./service-fixture.ts";
import { pinned, payload } from "./command-wait-fixture.ts";
import { start } from "./command-wait-check-fixture.ts";

function hostSettings(harness: Harness, overrides: Partial<ServiceOptions>) {
  const captured: HostPorts[] = [];
  const clock = { now: start, output: '{"ready":false}' };
  const calls: string[] = [];
  const settings = {
    workflows: [{ ...harness.registration, manifest: pinned, effectLimit: 2 }],
    clock: () => new Date(clock.now).toISOString(),
    host: (ports: HostPorts) => {
      captured.push(ports);
      return Promise.resolve({ close: () => Promise.resolve() });
    },
    delivery: {
      reconcile: () => Promise.resolve({ kind: "absent" as const }),
      deliver: (intent: {
        readonly kind: string;
        readonly operationId: string;
      }) => {
        if (intent.kind !== "protected-effect")
          return Promise.resolve({ receipt: "world-run" });
        calls.push(intent.operationId);
        return Promise.resolve({
          kind: "completed" as const,
          worker: "command",
          receipt: "command-receipt",
          result: clock.output,
        });
      },
    },
    ...overrides,
  };
  return { captured, clock, calls, settings };
}

export async function commandWaitHost(
  harness: Harness,
  overrides: Partial<ServiceOptions> = {},
) {
  const { captured, clock, calls, settings } = hostSettings(harness, overrides);
  const service = await harness.start(settings);
  const [ports] = captured;
  assert.ok(ports);
  const runId = text(
    await call(harness, {
      operation: "run",
      parameters: {
        workflowId: "develop",
        source: "prompt",
        submission: { prompt: "review" },
        commandId: "wait-run",
      },
    }),
    "runId",
  );
  assert.equal(
    (
      await service.worker.started({
        runId,
        commandId: "started",
        expectedRevision: 1,
      })
    ).kind,
    "accepted",
  );
  return {
    service,
    ports,
    runId,
    clock,
    calls,
    settings,
    currentPorts: () => {
      const latest = captured.at(-1);
      assert.ok(latest);
      return latest;
    },
    request: { runId, name: "team-review" },
    opening: { runId, name: "team-review", commandId: "open", input: payload },
    ...hostOperations({ harness, runId, ports }),
  };
}

function hostOperations(parts: {
  readonly harness: Harness;
  readonly runId: string;
  readonly ports: HostPorts;
}) {
  const { harness, runId, ports } = parts;
  return {
    budget: async () =>
      fields(
        field(
          field(
            await call(harness, {
              operation: "status",
              parameters: { runId },
            }),
            "run",
          ),
          "budget",
        ),
      ),
    ordinary: (round: number) =>
      ports.requestEffect({
        runId,
        commandId: `ordinary-${String(round)}`,
        scope: { phase: "ordinary", operation: "review", round },
        capability: "command",
        method: "run:review-state",
        target: "review-state",
        payload,
        units: 1,
      }),
  };
}
