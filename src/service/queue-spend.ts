import type { Fields } from "../protocol.ts";
import { queueSpending } from "../queue-spend.ts";
import { priceOf } from "../worker-usage.ts";
import type { OperationView } from "../broker/actor/authority.ts";
import { reportFields } from "./worker-totals.ts";
import type { ServiceContext } from "./replies.ts";

type SpendContext = Pick<
  ServiceContext,
  "authority" | "clock" | "queueDailySpendLimitUsd"
>;

export async function queueRun(
  context: Pick<ServiceContext, "authority">,
  run: { readonly runId: string; readonly workflowId: string | undefined },
): Promise<boolean> {
  return (
    run.workflowId === "develop-issue" ||
    (await context.authority.queries.manifest(run.runId))?.queue === true
  );
}

async function inWindow(
  context: SpendContext,
  turn: { readonly operation: OperationView; readonly now: number },
): Promise<boolean> {
  const { operation, now } = turn;
  if (operation.settledSequence === null) return false;
  const page = await context.authority.queries.eventsAfter({
    after: operation.settledSequence - 1,
    limit: 1,
    runId: operation.runId,
  });
  const event = page.events[0];
  if (event?.sequence !== operation.settledSequence)
    throw new Error("queue-spend-settlement-missing");
  const timestamp = Date.parse(event.recordedAt);
  return timestamp > now - 24 * 3_600_000 && timestamp <= now;
}

export async function queueSpend(context: SpendContext): Promise<Fields> {
  const limitUsd = context.queueDailySpendLimitUsd;
  if (limitUsd === undefined) return {};
  const workflows = await context.authority.queries.workflowIds();
  const state = await context.authority.state();
  const now = Date.parse(context.clock());
  const costs: number[] = [];
  const totals = {
    costs,
    unknownTurns: 0,
    turnsInWork: 0,
  };
  for (const runId of Object.keys(state.runs)) {
    if (!(await queueRun(context, { runId, workflowId: workflows[runId] })))
      continue;
    const operations = await context.authority.effects.operations(runId);
    for (const operation of operations.filter(
      (turn) => turn.capability === "claude",
    ))
      await countTurn(context, { operation, now, totals });
  }
  const spending = queueSpending(totals.costs, limitUsd);
  const spentUsd =
    totals.costs.length === 0 && totals.unknownTurns > 0
      ? null
      : spending.spentUsd;
  return {
    spend: {
      limitUsd,
      spentUsd,
      unknownTurns: totals.unknownTurns,
      turnsInWork: totals.turnsInWork,
      windowHours: 24,
      holding: spentUsd !== null && spending.holding,
    },
  };
}

async function countTurn(
  context: SpendContext,
  turn: {
    readonly operation: OperationView;
    readonly now: number;
    readonly totals: {
      costs: number[];
      unknownTurns: number;
      turnsInWork: number;
    };
  },
): Promise<void> {
  const { operation, totals } = turn;
  if (operation.settledSequence === null) {
    totals.turnsInWork += 1;
    return;
  }
  if (!(await inWindow(context, turn))) return;
  const report = reportFields(
    operation.result === null
      ? undefined
      : await context.authority.queries.document(operation.result),
  );
  const cost =
    priceOf(report["costUsd"]) ?? priceOf(report["estimatedCostUsd"]);
  if (cost === null) totals.unknownTurns += 1;
  else totals.costs.push(cost);
}
