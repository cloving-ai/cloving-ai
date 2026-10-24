import type { Harness } from "./service-fixture.ts";
import { call, fakeRegistration } from "./service-fixture.ts";
import { operationOf } from "./effect-fixture.ts";
import { runIdentity } from "../src/service/submission-handler.ts";
import type { ServiceOptions } from "../src/service/service.ts";

export function settings(harness: Harness) {
  return {
    runtimeDirectory: harness.runtimeDirectory,
    journal: harness.stateDirectory + "/handoffs",
    retryMilliseconds: 1,
    document: () => Promise.resolve('{"prompt":"next"}'),
    runStatus: () => Promise.resolve("running"),
  };
}

export const intent = {
  kind: "protected-effect" as const,
  purpose: "dispatch" as const,
  runId: runIdentity("handoff-source"),
  operationId: operationOf(runIdentity("handoff-source"), { round: 1 }),
  workflow: "source-pin",
  inputDigest: `sha256:${"a".repeat(64)}`,
  capability: "handoff",
  method: "run",
  target: "develop",
  payload: `sha256:${"b".repeat(64)}`,
  leaseGeneration: 1,
};

export async function startWithSource(
  harness: Harness,
  overrides: Partial<ServiceOptions> = {},
) {
  const service = await harness.start({
    ...overrides,
    workflows: [
      { ...fakeRegistration([]), workflowId: "source" },
      ...(overrides.workflows ?? [harness.registration]),
    ],
  });
  await call(harness, {
    operation: "run",
    parameters: {
      workflowId: "source",
      source: "input",
      submission: { prompt: "source" },
      commandId: "handoff-source",
    },
  });
  return service;
}
