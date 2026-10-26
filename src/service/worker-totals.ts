import { record, type Fields } from "../protocol.ts";
import {
  priceOf,
  usageOf,
  tokenCount,
  workerTotals,
  type WorkerTotals,
  type WorkerTurnUsage,
  type WorkerAttemptUsage,
} from "../worker-usage.ts";
import type { ServiceContext } from "./replies.ts";

function reportFields(text: string | undefined): Fields {
  try {
    return record(JSON.parse(text ?? "null")) ?? {};
  } catch {
    return {};
  }
}

function attemptsOf(value: unknown): readonly WorkerAttemptUsage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry: unknown) => {
    const fields = record(entry) ?? {};
    const attempt = tokenCount(fields["attempt"]);
    const model = fields["model"];
    if (
      attempt === null ||
      attempt === 0 ||
      (model !== null && typeof model !== "string")
    )
      return [];
    return [
      {
        attempt,
        model,
        usage: usageOf(fields["usage"]),
        costUsd: priceOf(fields["costUsd"]),
        estimatedCostUsd: priceOf(fields["estimatedCostUsd"]),
      },
    ];
  });
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
    const harness =
      report["harness"] ??
      (await context.workerHarness?.(operation.operationId));
    turns.push({
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
