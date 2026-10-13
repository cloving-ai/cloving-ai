import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface ClaimEvent {
  readonly eventType: string;
  readonly correlationId?: string | undefined;
}

interface EventPage {
  readonly data: readonly ClaimEvent[];
  readonly cursor: string | null;
  readonly hasMore: boolean;
}

export interface ClaimWorld {
  readonly runs: {
    readonly get: (
      runId: string,
      parameters: { readonly resolveData: "none" },
    ) => Promise<{ readonly status: string }>;
  };
  readonly events: {
    readonly list: (parameters: {
      readonly runId: string;
      readonly resolveData: "none";
      readonly pagination: {
        readonly limit: number;
        readonly sortOrder: "asc";
        readonly cursor?: string;
      };
    }) => Promise<EventPage>;
  };
}

interface Claim {
  readonly name: string;
  readonly runId: string;
  readonly stepId: string;
  readonly kind: "created" | "terminal";
}

const claimName = /^(wrun_[0-9A-Z]+)-(step_[0-9A-Z]+)\.(created|terminal)$/;
const runEnds = ["completed", "failed", "cancelled"];
const stepEnds = ["step_completed", "step_failed"];
const endFields = ["output", "error", "completedAt"];

function claimOf(name: string): Claim[] {
  const [, runId, stepId, kind] = claimName.exec(name) ?? [];
  if (runId === undefined || stepId === undefined) return [];
  return [
    { name, runId, stepId, kind: kind === "terminal" ? kind : "created" },
  ];
}

async function recorded(
  world: ClaimWorld,
  page: { readonly runId: string; readonly cursor: string | null },
): Promise<readonly ClaimEvent[]> {
  const { runId, cursor } = page;
  const listed = await world.events.list({
    runId,
    resolveData: "none",
    pagination: {
      limit: 1000,
      sortOrder: "asc",
      ...(cursor === null ? {} : { cursor }),
    },
  });
  if (!listed.hasMore || listed.cursor === null) return listed.data;
  return [
    ...listed.data,
    ...(await recorded(world, { runId, cursor: listed.cursor })),
  ];
}

function proven(claim: Claim, events: readonly ClaimEvent[]): boolean {
  const own = events
    .filter((event) => event.correlationId === claim.stepId)
    .map((event) => event.eventType);
  if (claim.kind === "created") return own.length > 0;
  return own.some((type) => stepEnds.includes(type));
}

async function orphans(
  world: ClaimWorld,
  held: { readonly runId: string; readonly claims: readonly Claim[] },
): Promise<readonly Claim[]> {
  const run = await world.runs
    .get(held.runId, { resolveData: "none" })
    .catch(() => undefined);
  if (run === undefined || runEnds.includes(run.status)) return [];
  const events = await recorded(world, { runId: held.runId, cursor: null });
  return held.claims.filter((claim) => !proven(claim, events));
}

function records(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null ? { ...value } : {};
}

async function reopened(path: string): Promise<void> {
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text === undefined) return;
  const parsed: unknown = JSON.parse(text);
  const step = records(parsed);
  if (step["status"] !== "completed" && step["status"] !== "failed") return;
  const kept = Object.entries(step).filter(
    ([field]) => !endFields.includes(field),
  );
  const staged = `${path}.reopened`;
  await writeFile(
    staged,
    JSON.stringify({ ...Object.fromEntries(kept), status: "running" }, null, 2),
  );
  await rename(staged, path);
}

async function reverted(dataDirectory: string, claim: Claim): Promise<void> {
  const path = join(
    dataDirectory,
    "steps",
    `${claim.runId}-${claim.stepId}.json`,
  );
  if (claim.kind === "created") await rm(path, { force: true });
  if (claim.kind === "terminal") await reopened(path);
}

export async function releaseStepClaims(
  dataDirectory: string,
  world: ClaimWorld,
): Promise<readonly string[]> {
  const folder = join(dataDirectory, ".locks", "steps");
  const names = await readdir(folder).catch(() => []);
  const held = Map.groupBy(names.flatMap(claimOf), (claim) => claim.runId);
  const released: string[] = [];
  for (const [runId, claims] of held)
    for (const claim of await orphans(world, { runId, claims })) {
      await reverted(dataDirectory, claim);
      await rm(join(folder, claim.name), { force: true });
      released.push(claim.name);
    }
  return released;
}
