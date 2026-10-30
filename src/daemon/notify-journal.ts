import { open, readFile, rename } from "node:fs/promises";
import { record } from "../protocol.ts";
import type { Notification } from "./notify-message.ts";

export interface DeliveryEntry {
  readonly key: string;
  readonly message: Notification | null;
  readonly state: "pending" | "sent" | "failed";
  readonly attempts: number;
  readonly lastAttemptAt: number | null;
  readonly lastFailure: string | null;
}

export interface RecordedNotifications {
  readonly entries: Map<string, DeliveryEntry>;
  readonly retiredKeys: Set<string>;
}

export async function recordedNotifications(
  file: string,
): Promise<RecordedNotifications | undefined> {
  const text = await readFile(file, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  });
  if (text === undefined) return undefined;
  const value: unknown = JSON.parse(text);
  const journal = record(value);
  if (journal?.["version"] === 1 && Array.isArray(journal["entries"])) {
    const entries = journal["entries"].map(deliveryEntry);
    const found = new Map(entries.map((entry) => [entry.key, entry]));
    if (found.size !== entries.length) throw new Error("invalid-notify-record");
    return {
      entries: found,
      retiredKeys: recordedKeys(journal["retiredKeys"] ?? []),
    };
  }
  const keys = recordedKeys(value);
  return {
    retiredKeys: new Set(),
    entries: new Map(
      [...keys].map((key) => [
        key,
        {
          key,
          message: null,
          state: "sent",
          attempts: 0,
          lastAttemptAt: Date.now(),
          lastFailure: null,
        },
      ]),
    ),
  };
}

function recordedKeys(value: unknown): Set<string> {
  if (
    !Array.isArray(value) ||
    !value.every((key: unknown) => typeof key === "string")
  )
    throw new Error("invalid-notify-record");
  return new Set(value.map(String));
}

function notification(value: unknown): value is Notification {
  const message = record(value);
  if (message === undefined) return false;
  return (
    ["decision", "blocked", "failed", "schedule-stopped"].includes(
      String(message["event"]),
    ) &&
    ["event", "runId", "workflowId", "subject", "body"].every(
      (field) => typeof message[field] === "string",
    )
  );
}

function deliveryState(value: unknown): value is DeliveryEntry["state"] {
  return value === "pending" || value === "sent" || value === "failed";
}

function attemptCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 5
  );
}

function attemptTime(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  );
}

function deliveryEntry(value: unknown): DeliveryEntry {
  const { key, message, state, attempts, lastAttemptAt, lastFailure } =
    record(value) ?? {};
  if (
    typeof key !== "string" ||
    !deliveryState(state) ||
    !attemptCount(attempts)
  )
    throw new Error("invalid-notify-record");
  if (
    !attemptTime(lastAttemptAt) ||
    !(lastFailure === null || typeof lastFailure === "string")
  )
    throw new Error("invalid-notify-record");
  const content = { message, state };
  if (!entryMessage(content)) throw new Error("invalid-notify-record");
  return {
    key,
    message: content.message,
    state,
    attempts,
    lastAttemptAt,
    lastFailure,
  };
}

function entryMessage(entry: {
  readonly message: unknown;
  readonly state: DeliveryEntry["state"];
}): entry is {
  readonly message: Notification | null;
  readonly state: DeliveryEntry["state"];
} {
  return entry.message === null
    ? entry.state === "sent"
    : notification(entry.message);
}

export async function saveNotifications(
  file: string,
  journal: {
    readonly entries: ReadonlyMap<string, DeliveryEntry>;
    readonly retiredKeys: ReadonlySet<string>;
  },
): Promise<void> {
  const temporary = await open(`${file}.tmp`, "w", 0o600);
  try {
    await temporary.chmod(0o600);
    await temporary.writeFile(
      JSON.stringify({
        version: 1,
        entries: [...journal.entries.values()],
        ...(journal.retiredKeys.size > 0
          ? { retiredKeys: [...journal.retiredKeys] }
          : {}),
      }) + "\n",
    );
    await temporary.sync();
  } finally {
    await temporary.close();
  }
  await rename(`${file}.tmp`, file);
}
