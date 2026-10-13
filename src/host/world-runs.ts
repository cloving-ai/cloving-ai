import { getRun } from "workflow/api";
import { getWorld } from "workflow/runtime";
import type { WorldRun } from "../authority/reconciliation.ts";

export const runTag = "cloving.run";
export const operationTag = "cloving.operation";

export interface TaggedRun extends WorldRun {
  readonly operationId: string | null;
  readonly createdAt: string;
}

function tag(attributes: unknown, name: string): string | null {
  const value: unknown = Reflect.get(Object(attributes), name);
  return typeof value === "string" ? value : null;
}

type World = Awaited<ReturnType<typeof getWorld>>;

interface Page {
  readonly limit: number;
  readonly cursor: string | null;
}

async function collected(world: World, page: Page): Promise<TaggedRun[]> {
  const listed = await world.runs.list({
    resolveData: "none",
    pagination: {
      limit: page.limit,
      ...(page.cursor === null ? {} : { cursor: page.cursor }),
    },
  });
  const found = listed.data.flatMap((item): TaggedRun[] => {
    const runId = tag(item.attributes, runTag);
    if (runId === null) return [];
    return [
      {
        runId,
        operationId: tag(item.attributes, operationTag),
        receipt: item.runId,
        status: item.status,
        createdAt: item.createdAt.toISOString(),
      },
    ];
  });
  if (!listed.hasMore || listed.cursor === null) return found;
  return [
    ...found,
    ...(await collected(world, { limit: page.limit, cursor: listed.cursor })),
  ];
}

export async function taggedRuns(pageSize = 200): Promise<TaggedRun[]> {
  return await collected(await getWorld(), { limit: pageSize, cursor: null });
}

export async function outcomeKind(
  receipt: string,
): Promise<string | undefined> {
  const value: unknown = await getRun(receipt).returnValue;
  const kind: unknown = Reflect.get(Object(value), "kind");
  return typeof kind === "string" ? kind : undefined;
}

export async function cancelled(receipt: string): Promise<string> {
  const run = getRun(receipt);
  await run.cancel().catch(() => undefined);
  return await run.status;
}

export async function taggedRun(
  receipt: string,
): Promise<{ readonly runId: string } | undefined> {
  const world = await getWorld();
  const run = await world.runs
    .get(receipt, { resolveData: "none" })
    .catch(() => undefined);
  const runId = tag(run?.attributes, runTag);
  return runId === null ? undefined : { runId };
}
