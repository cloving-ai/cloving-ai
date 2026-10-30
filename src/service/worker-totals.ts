import { record, type Fields } from "../protocol.ts";
import {
  priceOf,
  usageOf,
  attemptsOf,
  workerTotals,
  type WorkerTotals,
  type WorkerTurnUsage,
} from "../worker-usage.ts";
import type { ServiceContext } from "./replies.ts";

export function reportFields(text: string | undefined): Fields {
  try {
    return record(JSON.parse(text ?? "null")) ?? {};
  } catch {
    return {};
  }
}

export async function usageTotals(
  context: ServiceContext,
  runId: string,
): Promise<WorkerTotals> {
  const { effects, queries } = context.authority;
  const operations = (await effects.operations(runId)).filter(
    (operation) =>
      operation.capability === "claude" &&
      ["completed", "failed", "stopped", "cancelled", "refused"].includes(
        operation.status,
      ),
  );
  const turns: WorkerTurnUsage[] = [];
  for (const operation of operations) {
    const report = reportFields(
      operation.result === null
        ? undefined
        : await queries.document(operation.result),
    );
    const attempts = attemptsOf(report["attempts"]);
    const model = report["model"];
    const summary = report["summary"];
    const harness =
      report["harness"] ??
      (await context.workerHarness?.(operation.operationId));
    turns.push({
      ...(typeof model === "string" ? { model } : {}),
      ...(typeof summary === "string" ? { summary } : {}),
      ...(typeof harness === "string" ? { harness } : {}),
      ...(attempts === undefined ? {} : { attempts }),
      operationId: operation.operationId,
      usage: usageOf(report["usage"]),
      costUsd: priceOf(report["costUsd"]),
      estimatedCostUsd: priceOf(report["estimatedCostUsd"]),
    });
  }
  return workerTotals(turns);
}
