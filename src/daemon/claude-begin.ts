import { rm } from "node:fs/promises";
import { join } from "node:path";
import { turnStartEnvironment } from "./turn-variables.ts";
import { profileCommand, type TurnProfile } from "../turn-profile.ts";
import type { RunningTurn } from "./claude-turn.ts";
import { turnOutcome } from "./turn-report.ts";
import { startRetriedTurn } from "./retrying-turn.ts";
import { reportOf, writeRecord as written } from "./operation-journal.ts";
import type { TurnResume } from "./claude-recovery.ts";
import type { TurnAttach, WaitResume } from "./turn-attempts.ts";
import { noteMetadata } from "./turn-notes.ts";
import {
  claudeLimits,
  type Active,
  type Parts,
  type Started,
} from "./claude-worker-parts.ts";

const worker = "claude";

async function concluded(
  parts: Parts,
  running: Started & {
    readonly turn: RunningTurn;
    readonly stopping: Active["stopping"];
  },
): Promise<void> {
  const { intent, key } = running;
  const recorded = await turnOutcome(
    { ...running, limits: claudeLimits },
    await running.turn.ended,
  );
  await written(running.folder, { name: "result.json", value: recorded });
  if (recorded.stoppedBy === "daemon-shutdown") return;
  await parts.settings.report(
    reportOf({ intent, commandId: `claude-turn:${key}`, worker }, recorded),
  );
}

function turnMetadata(start: Started) {
  const { intent, tree, harness } = start;
  return {
    ...noteMetadata(start),
    harness: harness.worker,
    operationId: intent.operationId,
    target: intent.target,
    branch: tree.branch,
    worktree: tree.path,
    startCommit: tree.startCommit,
  };
}

export async function begun(
  parts: Parts,
  start: Started & {
    readonly prompt: string;
    readonly profile: TurnProfile;
    readonly resume?: TurnResume;
    readonly attach?: TurnAttach;
    readonly wait?: WaitResume;
    readonly signal: AbortSignal;
  },
): Promise<void> {
  const { intent, key, folder, tree, prompt, harness } = start;
  const stopping = { requested: false, controller: new AbortController() };
  const cancel = () => {
    stopping.controller.abort();
  };
  start.signal.addEventListener("abort", cancel, { once: true });
  if (start.signal.aborted) cancel();
  const environment = await turnStartEnvironment(parts.settings, start);
  if (start.wait !== undefined)
    await rm(join(folder, "result.json"), { force: true });
  const turn = startRetriedTurn(
    {
      ...harness,
      resultBytes: claudeLimits.resultBytes,
      command: profileCommand(harness.command, start.profile),
      environment,
      turnId: `${intent.runId}-${key}`,
      directory: tree.path,
      folder,
      prompt,
      release: parts.release.signal,
    },
    {
      ...parts.settings,
      ...start.turnSettings,
      ...(start.resume === undefined ? {} : { resume: start.resume }),
      ...(start.attach === undefined ? {} : { attach: start.attach }),
      ...(start.wait === undefined ? {} : { waiting: start.wait }),
      runId: intent.runId,
      stopping: stopping.controller,
      metadata: turnMetadata(start),
    },
  );
  parts.active.set(key, {
    worker: harness.worker,
    intent,
    turn,
    stopping,
    concluded: turn
      .then((running) =>
        concluded(parts, { ...start, turn: running, stopping }),
      )
      .catch(() => undefined)
      .finally(() => parts.active.delete(key)),
  });
  await turn.finally(() => {
    start.signal.removeEventListener("abort", cancel);
  });
}
