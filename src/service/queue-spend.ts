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
  runId: string,
): Promise<boolean> {
  const { queries } = context.authority;
  if ((await queries.manifest(runId))?.queue === true) return true;
  if ((await queries.workflowIds([runId]))[runId] !== "develop-issue")
    return false;
  const { events } = await queries.eventsAfter({ runId, after: 0, limit: 1 });
  return (
    events[0]?.type === "run.created" &&
    events[0].payload["resolver"] === "issue-command:1"
  );
}

export async function queueSpend(context: SpendContext): Promise<Fields> {
  const limitUsd = context.queueDailySpendLimitUsd;
  if (limitUsd === undefined) return {};
  const now = Date.parse(context.clock());
  const operations = await context.authority.effects.workerTurns({
    after: new Date(now - 24 * 3_600_000).toISOString(),
    through: new Date(now).toISOString(),
  });
  const runIds = [...new Set(operations.map((operation) => operation.runId))];
  const costs: number[] = [];
  const totals = {
    costs,
    unknownTurns: 0,
    turnsInWork: 0,
  };
  const queued = new Set<string>();
  for (const runId of runIds) {
    if (await queueRun(context, runId)) queued.add(runId);
  }
  for (const operation of operations) {
    if (queued.has(operation.runId))
      await countTurn(context, { operation, totals });
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
