import { record, type Fields, type Reply } from "../protocol.ts";
import { costTotal, queueSpending } from "../queue-spend.ts";
import { reportedPrice } from "../worker-usage.ts";
import type { OperationView } from "../broker/actor/authority.ts";
import { failed, result, type ServiceContext } from "./replies.ts";

type SpendContext = Pick<
  ServiceContext,
  "authority" | "clock" | "queueDailySpendLimitUsd" | "spendScope"
>;

export async function spendCounted(
  context: Pick<ServiceContext, "authority" | "spendScope">,
  runId: string,
): Promise<boolean> {
  return context.spendScope === "all" || (await queueRun(context, runId));
}

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

export async function spendLimitRefusal(
  context: SpendContext,
  identity: Fields,
): Promise<Reply | undefined> {
  const spend = record((await queueSpend(context))["spend"]);
  if (spend?.["holding"] !== true) return undefined;
  return failed("queue-spend-limit", {
    ...identity,
    detail: "Queue holding for spend limit.",
  });
}

interface SpendTotals {
  readonly costs: number[];
  unknownTurns: number;
  turnsInWork: number;
}

async function spendTotals(
  context: Omit<SpendContext, "queueDailySpendLimitUsd">,
): Promise<SpendTotals> {
  const now = Date.parse(context.clock());
  const operations = await context.authority.effects.workerTurns({
    after: new Date(now - 24 * 3_600_000).toISOString(),
    through: new Date(now).toISOString(),
  });
  const runIds = [...new Set(operations.map((operation) => operation.runId))];
  const totals: SpendTotals = { costs: [], unknownTurns: 0, turnsInWork: 0 };
  const queued = new Set<string>();
  for (const runId of runIds) {
    if (await spendCounted(context, runId)) queued.add(runId);
  }
  for (const operation of operations) {
    if (queued.has(operation.runId))
      await countTurn(context, { operation, totals });
  }
  return totals;
}

function spentOf(totals: SpendTotals): number | null {
  return totals.costs.length === 0 && totals.unknownTurns > 0
    ? null
    : costTotal(totals.costs);
}

export async function spendRead(
  context: Omit<SpendContext, "queueDailySpendLimitUsd">,
): Promise<Reply> {
  const totals = await spendTotals(context);
  return result("spend", {
    spentUsd: spentOf(totals),
    unknownTurns: totals.unknownTurns,
    turnsInWork: totals.turnsInWork,
    windowHours: 24,
  });
}

export async function queueSpend(context: SpendContext): Promise<Fields> {
  const limitUsd = context.queueDailySpendLimitUsd;
  if (limitUsd === undefined) return {};
  const totals = await spendTotals(context);
  const spentUsd = spentOf(totals);
  return {
    spend: {
      limitUsd,
      spentUsd,
      unknownTurns: totals.unknownTurns,
      turnsInWork: totals.turnsInWork,
      windowHours: 24,
      holding:
        spentUsd !== null && queueSpending(totals.costs, limitUsd).holding,
    },
  };
}

async function countTurn(
  context: Pick<SpendContext, "authority">,
  turn: {
    readonly operation: OperationView;
    readonly totals: SpendTotals;
  },
): Promise<void> {
  const { operation, totals } = turn;
  if (operation.settledSequence === null) {
    totals.turnsInWork += 1;
    return;
  }
  const cost = reportedPrice(
    operation.result === null
      ? undefined
      : await context.authority.queries.document(operation.result),
  );
  if (cost === null) totals.unknownTurns += 1;
  else totals.costs.push(cost);
}
