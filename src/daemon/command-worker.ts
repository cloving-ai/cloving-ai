import type { LocalCommands } from "../command-settings.ts";
import type {
  AdapterOutcome,
  Delivery,
  DeliveryIntent,
  ProtectedIntent,
} from "../broker/actor/delivery-intents.ts";
import {
  located,
  readRecord,
  writeRecord,
  replied,
  reportOf,
  type WorkerReport,
  type Recorded,
  type Located,
} from "./operation-journal.ts";
import {
  startCommand,
  type RunningCommand,
  type CommandEnd,
  type CommandClock,
} from "./command-process.ts";
import {
  claimCommand,
  commandStarted,
  recordCommandResult,
} from "./command-journal.ts";

export interface CommandWorkerSettings {
  readonly repository: string;
  readonly journal: string;
  readonly commands: LocalCommands;
  readonly seconds?: number;
  readonly commandClock?: CommandClock;
  readonly document: (digest: string) => Promise<string | undefined>;
  readonly report: (report: WorkerReport) => Promise<unknown>;
}

export interface CommandWorker extends Delivery {
  readonly recover: (intents: readonly DeliveryIntent[]) => Promise<void>;
  readonly stop: NonNullable<Delivery["stop"]>;
  readonly close: () => Promise<void>;
}

interface Active {
  readonly command: RunningCommand;
  readonly concluded: Promise<void>;
  readonly stopping: { requested: boolean };
}

interface Parts {
  readonly settings: CommandWorkerSettings;
  readonly active: Map<string, Active>;
  readonly pending: Map<string, Pending>;
}

interface Pending {
  readonly opening: ReturnType<Delivery["deliver"]>;
  readonly stopping: AbortController;
}

function commandIntent(intent: DeliveryIntent): intent is ProtectedIntent {
  return (
    intent.capability === "command" &&
    /^run:[A-Za-z0-9-]{1,64}$/.test(intent.method ?? "") &&
    intent.payload !== undefined &&
    intent.target !== undefined &&
    intent.leaseGeneration !== undefined
  );
}

async function reconciled(
  parts: Parts,
  call: { readonly intent: DeliveryIntent; readonly origin?: "dispatch" },
): Promise<AdapterOutcome> {
  const { intent, origin } = call;
  const { key, folder } = located(parts.settings.journal, intent.operationId);
  const result = await readRecord(folder, "result.json");
  if (result !== undefined)
    return replied({ receipt: key, worker: "command" }, result);
  const inFlight = (): boolean =>
    parts.active.has(key) || (origin !== "dispatch" && parts.pending.has(key));
  if (inFlight()) return { kind: "accepted", receipt: key, worker: "command" };
  if (!(await commandStarted(folder))) return { kind: "absent" };
  const started = await readRecord(folder, "started.json");
  if (inFlight()) return { kind: "accepted", receipt: key, worker: "command" };
  const duration =
    Date.now() - Date.parse(String(Reflect.get(Object(started), "startedAt")));
  await recordCommandResult(folder, {
    outcome: "failed",
    reason: "command-interrupted",
    exitCode: null,
    durationMilliseconds: Number.isFinite(duration) ? Math.max(0, duration) : 0,
    endedAt: new Date().toISOString(),
  });
  return replied(
    { receipt: key, worker: "command" },
    await readRecord(folder, "result.json"),
  );
}

interface Started extends Located {
  readonly intent: ProtectedIntent;
  readonly payload: string;
  readonly command: readonly string[];
}

function ending(end: CommandEnd, stopping: Active["stopping"]): Recorded {
  const endedAt = new Date().toISOString();
  if (stopping.requested) return { outcome: "stopped", endedAt };
  if (end.reason !== undefined)
    return { outcome: "failed", reason: end.reason, endedAt };
  return { outcome: "completed", result: end.stdout, endedAt };
}

function begun(parts: Parts, start: Started): void {
  const { settings } = parts;
  const { intent, key, folder, payload, command } = start;
  const running = startCommand(
    {
      command,
      directory: settings.repository,
      folder,
      payload,
      runId: intent.runId,
      operationId: intent.operationId,
      seconds: settings.seconds ?? 60,
      ...(intent.commandDeadline === undefined
        ? {}
        : { deadline: intent.commandDeadline }),
    },
    settings.commandClock,
  );
  const stopping = { requested: false };
  const concluded = running.ended
    .then(async (end) => {
      const recorded = {
        ...ending(end, stopping),
        exitCode: end.exitCode,
        durationMilliseconds: end.durationMilliseconds,
      };
      if (!(await recordCommandResult(folder, recorded))) return;
      await settings.report(
        reportOf(
          { intent, commandId: `command:${key}`, worker: "command" },
          recorded,
        ),
      );
    })
    .catch(() => undefined)
    .finally(() => parts.active.delete(key));
  parts.active.set(key, { command: running, concluded, stopping });
}

function startRecord(intent: ProtectedIntent) {
  return {
    runId: intent.runId,
    operationId: intent.operationId,
    name: intent.method.slice(4),
    startedAt: new Date().toISOString(),
    ...(intent.commandDeadline === undefined
      ? {}
      : { deadline: intent.commandDeadline }),
  };
}

async function delivered(
  parts: Parts,
  call: { readonly intent: DeliveryIntent; readonly signal: AbortSignal },
): ReturnType<Delivery["deliver"]> {
  const { intent, signal } = call;
  const aborted = (): boolean => signal.aborted;
  if (!commandIntent(intent))
    return { kind: "failed", reason: "unsupported-effect" };
  if (aborted()) return { kind: "failed", reason: "command-start-aborted" };
  const known = await reconciled(parts, { intent, origin: "dispatch" });
  if (known.kind !== "absent") return known;
  const { settings } = parts;
  const name = intent.method.slice(4);
  const command = Object.hasOwn(settings.commands, name)
    ? settings.commands[name]
    : undefined;
  if (command === undefined)
    return { kind: "failed", reason: "command-unknown" };
  const payload = await settings.document(intent.payload);
  if (payload === undefined)
    return { kind: "failed", reason: "payload-not-available" };
  if (aborted()) return { kind: "failed", reason: "command-start-aborted" };
  const place = located(settings.journal, intent.operationId);
  if (!(await claimCommand(place.folder)))
    return reconciled(parts, { intent, origin: "dispatch" });
  await writeRecord(place.folder, {
    name: "started.json",
    value: startRecord(intent),
  });
  if (aborted()) return reconciled(parts, { intent, origin: "dispatch" });
  begun(parts, { ...place, intent, payload, command });
  return { receipt: place.key, worker: "command" };
}

async function recovered(
  parts: Parts,
  intents: readonly DeliveryIntent[],
): Promise<void> {
  for (const intent of intents) {
    if (!commandIntent(intent)) continue;
    await parts.pending.get(
      located(parts.settings.journal, intent.operationId).key,
    )?.opening;
    const result = await reconciled(parts, { intent });
    if (
      result.kind === "completed" ||
      result.kind === "failed" ||
      result.kind === "stopped"
    )
      await parts.settings.report(
        reportOf(
          {
            intent,
            commandId: `command:${located(parts.settings.journal, intent.operationId).key}`,
            worker: "command",
          },
          {
            ...result,
            outcome: result.kind,
            endedAt: new Date().toISOString(),
          },
        ),
      );
  }
}

export function commandWorker(settings: CommandWorkerSettings): CommandWorker {
  const parts: Parts = { settings, active: new Map(), pending: new Map() };
  const closing = new AbortController();
  const { pending } = parts;
  return {
    recover: (intents) => recovered(parts, intents),
    deliver: (intent, signal) => {
      const { key } = located(settings.journal, intent.operationId);
      const known = pending.get(key);
      if (known !== undefined) return known.opening;
      const stopping = new AbortController();
      const opening = delivered(parts, {
        intent,
        signal: AbortSignal.any([signal, closing.signal, stopping.signal]),
      }).finally(() => pending.delete(key));
      pending.set(key, { opening, stopping });
      return opening;
    },
    reconcile: (intent) => {
      const { key } = located(settings.journal, intent.operationId);
      return pending.has(key)
        ? Promise.resolve({ kind: "accepted", receipt: key, worker: "command" })
        : reconciled(parts, { intent });
    },
    stop: async (intent) => {
      const { key } = located(settings.journal, intent.operationId);
      const opening = pending.get(key);
      opening?.stopping.abort();
      await opening?.opening;
      const active = parts.active.get(key);
      if (active !== undefined) active.stopping.requested = true;
      active?.command.stop();
      await active?.concluded;
      return reconciled(parts, { intent });
    },
    close: async () => {
      closing.abort();
      await Promise.all([...pending.values()].map((entry) => entry.opening));
      const active = [...parts.active.values()];
      for (const running of active) {
        running.stopping.requested = true;
        running.command.stop();
      }
      await Promise.all(active.map((running) => running.concluded));
    },
  };
}
