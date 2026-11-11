import { turnHarness } from "../harness-defaults.ts";
import { resumeReasonField } from "../worker-usage.ts";
import { record } from "../protocol.ts";
import type { ProtectedIntent } from "../broker/actor/delivery-intents.ts";
import { join } from "node:path";
import { located, readRecord, writeRecord } from "./operation-journal.ts";
import { keepTurn } from "./turn-owners.ts";
import {
  priorEnd,
  recordedField,
  recordedTexts,
  recordedTree,
} from "./claude-recovery.ts";
import { foundLaunch, launchState, markerRecord } from "./detached-process.ts";
import {
  attemptNumber,
  keptLaunch,
  plannedLaunch,
  type TurnLaunch,
} from "../turn-launch.ts";
import type { TurnAttach } from "./turn-attempts.ts";
import { selectedProfile, type WorkerProfiles } from "./worker-profile.ts";

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
  found: {
    readonly started: unknown;
    readonly attempt: number;
    readonly launch: TurnLaunch;
  },
): Promise<void> {
  const { launch } = found;
  const running = {
    ...record(found.started),
    phase: "running",
    processId: launch.processId,
    launch,
  };
  await writeRecord(folder, {
    name: `attempt-${String(found.attempt)}.json`,
    value: {
      ...running,
      startedAt: new Date(Date.parse(launch.processStart)).toISOString(),
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

export async function markedTurn(
  folder: string,
  request: { readonly started: unknown; readonly stopMilliseconds: number },
): Promise<TurnLaunch | "stopped" | "unknown" | undefined> {
  const { started } = request;
  const attempt = attemptNumber(started);
  if (attempt === undefined || recordedField(started, "phase") !== "starting")
    return undefined;
  const place =
    attempt === 1 ? folder : join(folder, `attempt-${String(attempt)}`);
  const planned = plannedLaunch(await readRecord(place, markerRecord));
  if (planned === undefined) return undefined;
  const launch = await foundLaunch(planned, {
    since: Date.parse(String(recordedField(started, "startedAt"))),
    stopMilliseconds: request.stopMilliseconds,
  });
  if (launch === undefined || launch === "stopped" || launch === "unknown")
    return launch;
  await connectedRecords(folder, { started, attempt, launch });
  return launch;
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
  return { attach, tree, profile, harness };
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

export async function holdKeptTurn(
  journal: string,
  intent: { readonly runId: string; readonly operationId: string },
): Promise<void> {
  const kept = await keptTurn(journal, intent);
  if (kept !== undefined) keepTurn(kept.directory, kept);
}
