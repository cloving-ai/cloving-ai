import {
  priceOf,
  reportFields,
  usageOf,
  attemptsOf,
  workerTotals,
  type WorkerTotals,
  type WorkerTurnUsage,
} from "../worker-usage.ts";
import type { OperationView } from "../broker/actor/effect-queries.ts";
import type { ServiceContext } from "./replies.ts";
import type { TurnDetails } from "../record-retention.ts";

function deliveryKey(operation: OperationView): string {
  return JSON.stringify([operation.receipt, operation.result]);
}

async function continuedDeliveries(
  context: ServiceContext,
  continuedFrom: string | undefined,
): Promise<ReadonlySet<string>> {
  if (continuedFrom === undefined) return new Set();
  const operations = await context.authority.effects.operations(continuedFrom);
  return new Set(
    operations
      .filter((operation) => operation.result !== null)
      .map(deliveryKey),
  );
}

export async function usageTotals(
  context: ServiceContext,
  run: { readonly runId: string; readonly continuedFrom?: string },
): Promise<WorkerTotals> {
  const { effects, queries } = context.authority;
  const continued = await continuedDeliveries(context, run.continuedFrom);
  const operations = (await effects.operations(run.runId)).filter(
    (operation) =>
      operation.capability === "claude" &&
      ["completed", "failed", "stopped", "cancelled"].includes(
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
      ...(continued.has(deliveryKey(operation)) ? { reused: true } : {}),
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

export async function turnDetailsOf(
  context: ServiceContext,
  run: { readonly runId: string; readonly totals: WorkerTotals },
): Promise<{ readonly turnDetails?: TurnDetails }> {
  const details = await context.turnDetails?.({
    runId: run.runId,
    operationIds: run.totals.workerTurns.map((turn) => turn.operationId),
  });
  return details === undefined ? {} : { turnDetails: details };
}
