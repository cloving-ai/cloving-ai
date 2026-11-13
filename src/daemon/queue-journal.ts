import {
  link,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { record } from "../protocol.ts";
import {
  queueFailureLimit,
  type QueueCommand,
  type QueueDrain,
  type QueueLaneRequest,
} from "../queue-state.ts";

export async function queueDirectory(
  directory: string,
  options: { readonly workflowId: string; readonly migrate?: boolean },
): Promise<string> {
  const folder = join(directory, "queues", options.workflowId);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  if (options.migrate === true) {
    for (const name of ["queue-commands.json", "queue-holds.json"]) {
      const source = join(directory, name);
      const moved = await link(source, join(folder, name)).then(
        () => true,
        (error: unknown) => {
          if (
            error instanceof Error &&
            "code" in error &&
            ["ENOENT", "EEXIST"].includes(String(error.code))
          )
            return false;
          throw error;
        },
      );
      if (moved) await unlink(source);
    }
  }
  return folder;
}

export const queueControlLimit = 32;

export type QueueControlRecord =
  | {
      readonly commandId: string;
      readonly command: QueueCommand;
      readonly scope?: "workflow";
    }
  | (QueueLaneRequest & { readonly command: "lanes" });

export interface SelfUpdateHold {
  readonly mark: string;
  readonly startedAt: number;
}

export interface QueueJournal {
  readonly commands: Set<string>;
  readonly failures: string[];
  readonly controls: QueueControlRecord[];
  readonly save: () => Promise<void>;
  retryCommandId: string | undefined;
  selfUpdateHold: SelfUpdateHold | undefined;
  drain: QueueDrain | undefined;
}

function savedHold(value: unknown): SelfUpdateHold | undefined {
  if (value === undefined) return undefined;
  const held = record(value);
  if (
    typeof held?.["mark"] !== "string" ||
    typeof held["startedAt"] !== "number" ||
    !Number.isFinite(held["startedAt"]) ||
    held["startedAt"] <= 0
  )
    throw new Error("invalid-queue-commands");
  return { mark: held["mark"], startedAt: held["startedAt"] };
}

function instant(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function savedScope(value: unknown): "workflow" | undefined {
  if (value === undefined || value === "workflow") return value;
  throw new Error("invalid-queue-commands");
}

function savedDrain(value: unknown): QueueDrain | undefined {
  if (value === undefined) return undefined;
  const drain = record(value);
  const drainedAt = drain?.["drainedAt"];
  if (
    !instant(drain?.["startedAt"]) ||
    !(drainedAt === null || instant(drainedAt))
  )
    throw new Error("invalid-queue-commands");
  const scope = savedScope(drain["scope"]);
  return {
    startedAt: drain["startedAt"],
    drainedAt,
    ...(scope === undefined ? {} : { scope }),
  };
}

function savedLaneControl(
  control: Readonly<Record<string, unknown>>,
  commandId: string,
): QueueControlRecord {
  const lanes = control["lanes"];
  const expectedLanes = control["expectedLanes"];
  if (
    !Number.isSafeInteger(lanes) ||
    Number(lanes) < 1 ||
    Number(lanes) > 16 ||
    !Number.isSafeInteger(expectedLanes) ||
    Number(expectedLanes) < 1 ||
    Number(expectedLanes) > 16
  )
    throw new Error("invalid-queue-commands");
  return {
    command: "lanes",
    commandId,
    lanes: Number(lanes),
    expectedLanes: Number(expectedLanes),
  };
}

function savedControl(entry: unknown): QueueControlRecord {
  const control = record(entry);
  if (control === undefined) throw new Error("invalid-queue-commands");
  const { commandId, command } = control;
  if (typeof commandId !== "string" || commandId.length === 0)
    throw new Error("invalid-queue-commands");
  if (command === "lanes") return savedLaneControl(control, commandId);
  if (command !== "resume" && command !== "drain")
    throw new Error("invalid-queue-commands");
  const scope = savedScope(control["scope"]);
  if (command === "resume" && scope !== undefined)
    throw new Error("invalid-queue-commands");
  return { command, commandId, ...(scope === undefined ? {} : { scope }) };
}

function savedControls(value: unknown): QueueControlRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > queueControlLimit)
    throw new Error("invalid-queue-commands");
  return value.map(savedControl);
}

function identifiers(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((id) => typeof id === "string" && id.length > 0)
  )
    throw new Error("invalid-queue-commands");
  return value.map(String);
}

export async function queueJournal(directory: string): Promise<QueueJournal> {
  const file = join(directory, "queue-commands.json");
  const text = await readFile(file, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return "[]";
    throw error;
  });
  const value: unknown = JSON.parse(text);
  const saved = record(value);
  const commands = new Set(
    identifiers(Array.isArray(value) ? value : saved?.["commands"]),
  );
  const failures = Array.isArray(value) ? [] : identifiers(saved?.["failures"]);
  if (failures.length > queueFailureLimit)
    throw new Error("invalid-queue-commands");
  let saving = Promise.resolve();
  const write = async (): Promise<void> => {
    await writeFile(
      `${file}.tmp`,
      JSON.stringify({
        commands: [...commands],
        failures,
        selfUpdateHold: pending.selfUpdateHold,
        drain: pending.drain,
        controls: pending.controls.length === 0 ? undefined : pending.controls,
      }) + "\n",
      { mode: 0o600, flush: true },
    );
    await rename(`${file}.tmp`, file);
  };
  const pending: QueueJournal = {
    commands,
    failures,
    controls: savedControls(saved?.["controls"]),
    retryCommandId: undefined,
    selfUpdateHold: savedHold(saved?.["selfUpdateHold"]),
    drain: savedDrain(saved?.["drain"]),
    save: () => {
      saving = saving.then(write, write);
      return saving;
    },
  };
  return pending;
}
