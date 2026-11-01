import assert from "node:assert/strict";
import { writeDeclaredWorkflow } from "./workflow-folder-fixture.ts";
import type { EffectReport } from "../src/service/service.ts";
import { operationOf } from "./effect-fixture.ts";
import {
  effectScene,
  requested,
  shownEffects,
  untilStates,
  type Scene,
} from "./service-effect-fixture.ts";
import { field, type Harness } from "./service-fixture.ts";

export async function workerScene(harness: Harness): Promise<Scene> {
  const declaration = await writeDeclaredWorkflow(harness.projectDirectory);
  return effectScene(harness, {
    effectLimit: 20,
    workflowId: declaration.workflow.workflowId,
    capabilities: ["claude", "fake-harness"],
  });
}

export async function reportTurn(
  scene: Scene,
  turn: {
    readonly round: number;
    readonly result?: string;
    readonly outcome?: "completed" | "failed";
  },
): Promise<EffectReport> {
  const { round, result, outcome = "completed" } = turn;
  const reply = await requested(scene, {
    commandId: `request-${scene.runId}-${String(round)}`,
    round,
    capability: "claude",
  });
  const earlier = (await shownEffects(scene))
    .slice(0, round - 1)
    .map((operation) => String(field(operation, "state")));
  await untilStates(scene, [...earlier, "running"]);
  const running = (await shownEffects(scene)).at(-1);
  const report = {
    runId: scene.runId,
    commandId: `report-${scene.runId}-${String(round)}`,
    operationId: operationOf(scene.runId, { round }),
    inputDigest: String(reply.operation?.inputDigest),
    leaseGeneration: Number(field(running, "leaseGeneration")),
    worker: "worker-1",
    outcome,
    ...(result === undefined ? {} : { result }),
    ...(outcome === "failed" ? { reason: "claude-turn-failed" } : {}),
  };
  assert.equal(
    (await scene.service.worker.reportEffect(report)).disposition?.disposition,
    "applied",
  );
  return report;
}

export const scenarioUsage = [
  { input_tokens: 1500, cache_read_input_tokens: 800, output_tokens: 150 },
  { input_tokens: 300, cache_read_input_tokens: 100, output_tokens: 20 },
];
export const scenarioTotal = {
  input_tokens: 1800,
  cache_read_input_tokens: 900,
  output_tokens: 170,
};
export const unknownUsage = {
  input_tokens: null,
  cache_read_input_tokens: null,
  output_tokens: null,
};

export function turnResult(usage: unknown, costUsd: unknown = null): string {
  return JSON.stringify({ usage, costUsd });
}
