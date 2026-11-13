import { turnHarness } from "../harness-defaults.ts";
import { resumeReasonField } from "../worker-usage.ts";
import { record } from "../protocol.ts";
import type {
  AdapterOutcome,
  ProtectedIntent,
} from "../broker/actor/delivery-intents.ts";
import { join } from "node:path";
import {
  located,
  readRecord,
  writeRecord,
  type Located,
} from "./operation-journal.ts";
import { keepTurn } from "./turn-owners.ts";
import { markedProcesses } from "./process-identity.ts";
import {
  priorEnd,
  recordedField,
  recordedHarness,
  recordedTexts,
  recordedTree,
  resumableHarness,
  interruptedReply,
} from "./claude-recovery.ts";
import {
  completedLaunch,
  foundLaunch,
  launchState,
  markerRecord,
  stoppedLaunch,
  type FoundLaunch,
} from "./detached-process.ts";
import {
  attemptNumber,
  keptLaunch,
  plannedLaunch,
  type PlannedLaunch,
  type TurnLaunch,
} from "../turn-launch.ts";
import type { TurnAttach } from "./turn-attempts.ts";
import { selectedProfile, type WorkerProfiles } from "./worker-profile.ts";
import { ownedPiSession } from "./pi-session.ts";
import { releasedLaunch } from "./detached-turn.ts";
import { claudeLimits } from "./claude-worker-parts.ts";

export async function attachableLaunch(
  folder: string,
  started: unknown,
): Promise<TurnLaunch | "gone" | undefined> {
  const attempt = attemptNumber(started);
  if (attempt === undefined) return undefined;
  const entry = await readRecord(folder, `attempt-${String(attempt)}.json`);
  const launch = keptLaunch({ started, entry });
  if (launch === undefined) return undefined;
  return (await launchState(launch)) === "gone" ? "gone" : launch;
}

async function connectedRecords(
  folder: string,
  connected: {
    readonly started: unknown;
    readonly attempt: number;
    readonly found: FoundLaunch;
  },
): Promise<void> {
  const { launch, startedAt } = connected.found;
  const running = {
    ...record(connected.started),
    phase: "running",
    processId: launch.processId,
    launch,
  };
  await writeRecord(folder, {
    name: `attempt-${String(connected.attempt)}.json`,
    value: {
      ...running,
      startedAt: new Date(startedAt).toISOString(),
      sessionId: null,
      sessionCostUsd: null,
      costUsd: null,
    },
    permissions: "private",
  });
  await writeRecord(folder, {
    name: "started.json",
    value: running,
    permissions: "private",
  });
}

interface MarkerSearch {
  readonly attempt: number;
  readonly planned: PlannedLaunch;
  readonly since: number;
}

async function markerSearch(
  folder: string,
  started: unknown,
): Promise<MarkerSearch | undefined> {
  const attempt = attemptNumber(started);
  if (attempt === undefined || recordedField(started, "phase") !== "starting")
    return undefined;
  const place =
    attempt === 1 ? folder : join(folder, `attempt-${String(attempt)}`);
  const planned = plannedLaunch(await readRecord(place, markerRecord));
  if (planned === undefined) return undefined;
  const since = Date.parse(String(recordedField(started, "startedAt")));
  return { attempt, planned, since };
}

export async function markedTurn(
  folder: string,
  request: { readonly started: unknown; readonly stopMilliseconds: number },
): Promise<TurnLaunch | "stopped" | "unknown" | undefined> {
  const { started } = request;
  const search = await markerSearch(folder, started);
  if (search === undefined) return undefined;
  const found =
    (await foundLaunch(search.planned, {
      since: search.since,
      stopMilliseconds: request.stopMilliseconds,
    })) ?? (await completedLaunch(search.planned, search.since));
  if (found === undefined || found === "stopped" || found === "unknown")
    return found;
  await connectedRecords(folder, { started, attempt: search.attempt, found });
  return found.launch;
}

async function readAttach(
  folder: string,
  request: { readonly started: unknown; readonly launch: TurnLaunch },
): Promise<TurnAttach | undefined> {
  const { started, launch } = request;
  const attempt = attemptNumber(started);
  const startedAt = recordedField(started, "startedAt");
  if (attempt === undefined || typeof startedAt !== "string") return undefined;
  const records: unknown[] = [];
  for (let number = 1; number <= attempt; number += 1)
    records.push(await readRecord(folder, `attempt-${String(number)}.json`));
  const entry = records.at(-1);
  const entryStart = recordedField(entry, "startedAt");
  if (typeof entryStart !== "string") return undefined;
  const head = recordedField(started, "turnStartCommit");
  return {
    startedAt,
    turnStartCommit: typeof head === "string" ? head : null,
    ends: records.slice(0, -1).map(priorEnd),
    steerNotes: recordedTexts(started, "steerNotes"),
    entry: {
      ...record(entry),
      attempt,
      startedAt: entryStart,
      ...resumeReasonField(recordedField(entry, "resumedAfter")),
    },
    launch,
  };
}

export async function attachPlan(
  settings: WorkerProfiles,
  request: {
    readonly folder: string;
    readonly started: unknown;
    readonly intent: ProtectedIntent;
    readonly launch: TurnLaunch;
  },
) {
  const { folder, started, intent, launch } = request;
  const tree = recordedTree(started);
  const attach = await readAttach(folder, { started, launch });
  if (tree === undefined || attach === undefined)
    return "claude-turn-interrupted";
  const profile = await selectedProfile(settings, intent);
  if (typeof profile === "string") return "claude-turn-interrupted";
  const harness = turnHarness(settings, profile);
  if (recordedField(started, "harness") !== harness.worker)
    return "claude-turn-interrupted";
  if (harness.worker === "pi" && harness.output === "text")
    return "claude-turn-interrupted";
  if (harness.worker !== "pi") return { attach, tree, profile, harness };
  const piSession = await ownedPiSession({
    started,
    entry: attach.entry,
    folder,
    operationId: intent.operationId,
  });
  if (typeof piSession === "string") return piSession;
  return { attach, tree, profile, harness: { ...harness, piSession } };
}

export async function rejectedAttach(rejection: {
  readonly request: Located;
  readonly plan: string;
  readonly launch: TurnLaunch | undefined;
  readonly stopMilliseconds: number | undefined;
}): Promise<AdapterOutcome> {
  if (rejection.launch !== undefined) {
    await stoppedLaunch(
      rejection.launch,
      rejection.stopMilliseconds ?? claudeLimits.stopMilliseconds,
    );
    await releasedLaunch(rejection.launch);
  }
  return interruptedReply(rejection.request, rejection.plan);
}

export interface KeptTurn {
  readonly directory: string;
  readonly runId: string;
  readonly launch: TurnLaunch;
}

export async function keptTurn(
  journal: string,
  intent: { readonly runId: string; readonly operationId: string },
): Promise<KeptTurn | undefined> {
  const { folder } = located(journal, intent.operationId);
  const started = await readRecord(folder, "started.json");
  const tree = recordedTree(started);
  if (tree === undefined) return undefined;
  const launch = await attachableLaunch(folder, started);
  if (launch === undefined || launch === "gone") return undefined;
  return { directory: tree.path, runId: intent.runId, launch };
}

async function holdMarkedTurn(
  journal: string,
  intent: { readonly runId: string; readonly operationId: string },
): Promise<boolean> {
  const { folder } = located(journal, intent.operationId);
  const started = await readRecord(folder, "started.json");
  const tree = recordedTree(started);
  const search = await markerSearch(folder, started);
  if (tree === undefined || search === undefined) return false;
  const { marker } = search.planned;
  const found = await markedProcesses({ marker, since: search.since });
  for (const { processId, processStart } of found ?? [])
    keepTurn(tree.path, {
      runId: intent.runId,
      launch: { processId, processStart, marker },
    });
  return true;
}

export async function holdKeptTurn(
  journal: string,
  intent: { readonly runId: string; readonly operationId: string },
): Promise<boolean> {
  const kept = await keptTurn(journal, intent);
  if (kept === undefined) return holdMarkedTurn(journal, intent);
  keepTurn(kept.directory, kept);
  return true;
}

export async function recoverableTurn(
  journal: string,
  intent: { readonly runId: string; readonly operationId: string },
): Promise<boolean> {
  if (resumableHarness(await recordedHarness(journal, intent.operationId)))
    return true;
  if ((await keptTurn(journal, intent)) !== undefined) return true;
  const { folder } = located(journal, intent.operationId);
  return (
    (await markerSearch(folder, await readRecord(folder, "started.json"))) !==
    undefined
  );
}
