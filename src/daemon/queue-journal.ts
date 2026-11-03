import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { record } from "../protocol.ts";
import {
  queueFailureLimit,
  type QueueCommand,
  type QueueDrain,
} from "../queue-state.ts";

export const queueControlLimit = 32;

export interface QueueControlRecord {
  readonly commandId: string;
  readonly command: QueueCommand;
}

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

function savedDrain(value: unknown): QueueDrain | undefined {
  if (value === undefined) return undefined;
  const drain = record(value);
  const drainedAt = drain?.["drainedAt"];
  if (
    !instant(drain?.["startedAt"]) ||
    !(drainedAt === null || instant(drainedAt))
  )
    throw new Error("invalid-queue-commands");
  return { startedAt: drain["startedAt"], drainedAt };
}

function savedControls(value: unknown): QueueControlRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > queueControlLimit)
    throw new Error("invalid-queue-commands");
  return value.map((entry: unknown) => {
    const control = record(entry);
    const commandId = control?.["commandId"];
    const command = control?.["command"];
    if (
      typeof commandId !== "string" ||
      commandId.length === 0 ||
      (command !== "resume" && command !== "drain")
    )
      throw new Error("invalid-queue-commands");
    return { commandId, command };
  });
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
