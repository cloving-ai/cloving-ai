import type { ProtectedIntent } from "../broker/actor/delivery-intents.ts";
import { turnWait, type TurnWait } from "../turn-launch.ts";
import { waitEnd } from "../cli/turn-waits.ts";
import { readRecord } from "./operation-journal.ts";
import { recordedProfile } from "./claude-attach.ts";
import {
  priorEnd,
  recordedField,
  recordedTexts,
  recordedTree,
} from "./claude-recovery.ts";
import type { WaitResume } from "./turn-attempts.ts";
import type { WorkerProfiles } from "./worker-profile.ts";

export function keptWait(journal: {
  readonly started: unknown;
  readonly result: unknown;
}): TurnWait | undefined {
  if (recordedField(journal.result, "stoppedBy") !== "daemon-shutdown")
    return undefined;
  return turnWait(journal.started);
}

async function readWait(
  folder: string,
  started: unknown,
): Promise<WaitResume | undefined> {
  const wait = turnWait(started);
  const endsAt = wait === undefined ? undefined : waitEnd(wait);
  const startedAt = recordedField(started, "startedAt");
  if (wait === undefined || endsAt === undefined) return undefined;
  if (typeof startedAt !== "string") return undefined;
  const records: unknown[] = [];
  for (let number = 1; number <= wait.attempt; number += 1)
    records.push(await readRecord(folder, `attempt-${String(number)}.json`));
  const head = recordedField(started, "turnStartCommit");
  return {
    startedAt,
    turnStartCommit: typeof head === "string" ? head : null,
    ends: records.map(priorEnd),
    steerNotes: recordedTexts(started, "steerNotes"),
    endsAt,
  };
}

export async function waitPlan(
  settings: WorkerProfiles,
  request: {
    readonly folder: string;
    readonly started: unknown;
    readonly intent: ProtectedIntent;
  },
) {
  const { folder, started, intent } = request;
  const tree = recordedTree(started);
  const wait = await readWait(folder, started);
  if (tree === undefined || wait === undefined)
    return "claude-turn-interrupted";
  const selected = await recordedProfile(settings, { started, intent });
  if (typeof selected === "string") return selected;
  return { wait, tree, ...selected };
}
