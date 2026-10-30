import { usageOf, priceOf } from "../worker-usage.ts";
import type { TurnEnd } from "./claude-turn.ts";
import {
  located,
  readRecord,
  writeRecord,
  interrupted,
  replied,
  type Located,
  reportOf,
  type WorkerReport,
} from "./operation-journal.ts";
import type { WorkTree } from "./work-tree.ts";
import { turnHarness } from "../harness-defaults.ts";
import { selectedProfile, type WorkerProfiles } from "./worker-profile.ts";
import { indexFailure } from "./retry-worktree.ts";
import type {
  AdapterOutcome,
  DeliveryIntent,
  ProtectedIntent,
} from "../broker/actor/delivery-intents.ts";

export interface TurnResume {
  readonly startedAt: string;
  readonly turnStartCommit: string | null;
  readonly sessionId: string;
  readonly ends: readonly TurnEnd[];
}

export const resumePrompt =
  "This turn stopped because the Cloving daemon restarted. Continue the task from the point where it stopped. Run again each command or subagent that did not end. End with the result line that the task asks for.";

export function turnIntent(intent: DeliveryIntent): intent is ProtectedIntent {
  return (
    intent.capability === "claude" &&
    intent.method !== "run-turn:analyze-chats" &&
    (intent.method === "run-turn" ||
      /^run-turn:[A-Za-z0-9_-]{1,119}$/.test(intent.method ?? "")) &&
    intent.target !== undefined &&
    intent.payload !== undefined &&
    intent.leaseGeneration !== undefined
  );
}

export function recordedField(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return Reflect.get(value, name);
}

export function processAlive(processId: unknown): boolean {
  if (typeof processId !== "number") return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return recordedField(error, "code") === "EPERM";
  }
}

export function recordedTree(started: unknown): WorkTree | undefined {
  const path = recordedField(started, "worktree");
  const branch = recordedField(started, "branch");
  const startCommit = recordedField(started, "startCommit");
  return typeof path === "string" &&
    typeof branch === "string" &&
    typeof startCommit === "string"
    ? { path, branch, startCommit }
    : undefined;
}

export async function resumePlan(
  settings: WorkerProfiles,
  request: {
    readonly folder: string;
    readonly started: unknown;
    readonly intent: ProtectedIntent;
    readonly signal: AbortSignal;
  },
) {
  const { folder, started, intent, signal } = request;
  const resume = await readResume(folder, started);
  const tree = recordedTree(started);
  if (resume === undefined || tree === undefined)
    return "claude-turn-interrupted";
  const profile = await selectedProfile(settings, intent);
  if (typeof profile === "string") return "claude-turn-interrupted";
  const harness = turnHarness(settings, profile);
  if (
    harness.worker !== "claude" ||
    recordedField(started, "harness") !== "claude"
  )
    return "claude-turn-interrupted";
  const locked = await indexFailure({ directory: tree.path, signal });
  return locked === null ? { resume, tree, profile, harness } : locked.reason;
}

function priorEnd(record: unknown): TurnEnd {
  const field = (name: string): unknown => recordedField(record, name);
  const sessionId = field("sessionId");
  const model = field("model");
  const retryKind = field("retryKind");
  return {
    ...(retryKind === "capacity" ||
    retryKind === "network" ||
    retryKind === null
      ? { retryKind }
      : {}),
    ...(field("resumedAfter") === "daemon-restart"
      ? { resumedAfter: "daemon-restart" as const }
      : {}),
    exitCode: null,
    result: {
      sessionId: typeof sessionId === "string" ? sessionId : null,
      model: typeof model === "string" ? model : null,
      text: "",
      failed: true,
      costUsd: recordedSessionCost(record),
      turns: typeof field("turns") === "number" ? Number(field("turns")) : null,
      usage: usageOf(field("usage")),
    },
  };
}

function recordedSessionCost(record: unknown): number | null {
  const fields = typeof record === "object" && record !== null ? record : {};
  const name = Object.hasOwn(fields, "sessionCostUsd")
    ? "sessionCostUsd"
    : "costUsd";
  return priceOf(Reflect.get(fields, name));
}

function resumeHeader(started: unknown) {
  if (recordedField(started, "phase") === "waiting") return undefined;
  const attempt = recordedField(started, "attempt");
  const startedAt = recordedField(started, "startedAt");
  const head = recordedField(started, "turnStartCommit");
  if (
    typeof attempt !== "number" ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    attempt > 5 ||
    typeof startedAt !== "string"
  )
    return undefined;
  return {
    attempt,
    startedAt,
    turnStartCommit: typeof head === "string" ? head : null,
  };
}

export async function readResume(
  folder: string,
  started: unknown,
): Promise<TurnResume | undefined> {
  const header = resumeHeader(started);
  if (header === undefined) return undefined;
  const records: unknown[] = [];
  for (let number = 1; number <= header.attempt; number += 1)
    records.push(await readRecord(folder, `attempt-${String(number)}.json`));
  const sessionId = recordedField(records.at(-1), "sessionId");
  if (
    typeof sessionId !== "string" ||
    sessionId === "" ||
    records.filter(
      (record) => recordedField(record, "resumedAfter") === "daemon-restart",
    ).length >= 2
  )
    return undefined;
  return {
    sessionId,
    ends: records.map(priorEnd),
    startedAt: header.startedAt,
    turnStartCommit: header.turnStartCommit,
  };
}

export async function recordedHarness(
  journal: string,
  operationId: string,
): Promise<string | undefined> {
  const { folder } = located(journal, operationId);
  const started = await readRecord(folder, "started.json").catch(
    () => undefined,
  );
  const harness = recordedField(started, "harness");
  return typeof harness === "string" ? harness : undefined;
}

export async function interruptedReply(
  place: Located,
  reason: string,
): Promise<AdapterOutcome> {
  const ending = interrupted(reason);
  await writeRecord(place.folder, { name: "result.json", value: ending });
  return replied({ receipt: place.key, worker: "claude" }, ending);
}

export async function recoverTurn(
  operation: {
    readonly intent: ProtectedIntent;
    readonly journal: string;
    readonly report: (report: WorkerReport) => Promise<unknown>;
    readonly signal: AbortSignal;
  },
  reconcile: () => Promise<AdapterOutcome>,
): Promise<void> {
  const { intent, journal, report } = operation;
  if ((await recordedHarness(journal, intent.operationId)) !== "claude") return;
  const result = await reconcile();
  if (operation.signal.aborted) return;
  if (
    result.kind === "completed" ||
    result.kind === "failed" ||
    result.kind === "stopped"
  )
    await report(
      reportOf(
        {
          intent,
          worker: "claude",
          commandId: `claude-turn:${located(journal, intent.operationId).key}`,
        },
        {
          ...result,
          outcome: result.kind,
          endedAt: new Date().toISOString(),
        },
      ),
    );
}
