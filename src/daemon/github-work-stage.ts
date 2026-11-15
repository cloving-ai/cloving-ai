import { randomUUID } from "node:crypto";
import { isCommandId } from "../authority/commands.ts";
import { record, type Fields } from "../protocol.ts";
import type { OperationWork } from "../service/worker-port.ts";
import { readRecord, writeRecord, type Reported } from "./operation-journal.ts";

interface SavedStage extends Reported {
  readonly stageId: string;
  readonly state: "pending" | "released";
}

function savedStage(value: unknown, intent: Reported): SavedStage | undefined {
  if (value === undefined) return undefined;
  const saved = record(value);
  if (
    saved === undefined ||
    !["runId", "operationId", "inputDigest"].every(
      (key) => saved[key] === Reflect.get(intent, key),
    )
  )
    throw new Error("github-operation-stopped");
  return stageFields(saved, intent);
}

function stageFields(saved: Fields, intent: Reported): SavedStage {
  const generation = saved["leaseGeneration"];
  const state = saved["state"];
  const stageId = saved["stageId"];
  if (
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    generation > intent.leaseGeneration ||
    !isCommandId(stageId) ||
    (state !== "pending" && state !== "released")
  )
    throw new Error("github-operation-stopped");
  return { ...intent, leaseGeneration: generation, stageId, state };
}

function stageRecord(
  stage: OperationWork,
  state: SavedStage["state"],
): SavedStage {
  return {
    runId: stage.runId,
    operationId: stage.operationId,
    inputDigest: stage.inputDigest,
    leaseGeneration: stage.leaseGeneration,
    stageId: stage.stageId,
    state,
  };
}

export async function recordedWorkStage(
  intent: Reported,
  folder: string | undefined,
): Promise<OperationWork> {
  const saved =
    folder === undefined
      ? undefined
      : savedStage(await readRecord(folder, "work-stage.json"), intent);
  const stageId =
    saved?.state === "pending" &&
    saved.leaseGeneration === intent.leaseGeneration
      ? saved.stageId
      : `work:${randomUUID()}`;
  const stage: OperationWork = {
    ...intent,
    action: "enter",
    commandId: stageId,
    stageId,
  };
  if (folder !== undefined)
    await writeRecord(folder, {
      name: "work-stage.json",
      value: stageRecord(stage, "pending"),
      permissions: "private",
    });
  return stage;
}

export async function releasedWorkStage(
  stage: OperationWork,
  folder: string | undefined,
): Promise<void> {
  if (folder === undefined) return;
  const saved = savedStage(await readRecord(folder, "work-stage.json"), stage);
  if (saved?.stageId !== stage.stageId) return;
  await writeRecord(folder, {
    name: "work-stage.json",
    value: stageRecord(stage, "released"),
    permissions: "private",
  });
}
