import type { Authority } from "../src/broker/actor/authority.ts";
import type { ServiceContext } from "../src/service/replies.ts";
import { workflowRegistry } from "../src/service/registry.ts";
import { recorded } from "./authority-fixture.ts";
import { manifest, queryDatabase } from "./authority-store-fixture.ts";
import { call, field, type Harness } from "./service-fixture.ts";

export function statusContext(authority: Authority): ServiceContext {
  return {
    authority,
    registry: workflowRegistry([]),
    gateway: {
      execute: () =>
        Promise.reject(new Error("Status must not execute commands")),
    },
    clock: () => recorded.recordedAt,
    livenessMilliseconds: 5000,
    followMilliseconds: 20,
    resolverMilliseconds: 1000,
    textBytes: 4096,
    documentBytes: 65536,
  };
}

export function command(
  harness: Harness,
  parameters: Readonly<Record<string, unknown>>,
): Promise<Readonly<Record<string, unknown>>> {
  return call(harness, { operation: "run-command", parameters });
}

export async function view(harness: Harness, runId: string): Promise<unknown> {
  return field(
    await call(harness, { operation: "status", parameters: { runId } }),
    "run",
  );
}

export async function reasonCode(
  harness: Harness,
  runId: string,
): Promise<unknown> {
  return field(field(await view(harness, runId), "reason"), "code");
}

export async function condition(
  harness: Harness,
  runId: string,
): Promise<unknown> {
  return field(await view(harness, runId), "condition");
}

export function continuationOutcomes(harness: Harness): readonly unknown[] {
  return queryDatabase(
    harness.stateDirectory,
    "SELECT d.outcome FROM deliveries d JOIN outbox o ON o.operation_id = d.operation_id WHERE o.kind = 'continue-run' ORDER BY d.staged_sequence, d.rowid",
  ).map((row) => field(row, "outcome"));
}

export const changedManifest = {
  ...manifest,
  artifacts: { ...manifest.artifacts, "flow.mjs": "f".repeat(64) },
};
