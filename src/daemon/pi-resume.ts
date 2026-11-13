import { constants } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { record } from "../protocol.ts";
import { attemptNumber, recordedLaunch } from "../turn-launch.ts";
import { launchState } from "./detached-process.ts";
import { readRecord, writeRecord } from "./operation-journal.ts";
import { piSessionHeader, responseIdentity } from "./pi-records.ts";
import {
  createPiSession,
  ownedPiSession,
  type PiSession,
} from "./pi-session.ts";

export async function piResumeSession(request: {
  readonly started: unknown;
  readonly folder: string;
  readonly intent: { readonly operationId: string };
}): Promise<PiSession | string | undefined> {
  const started = record(request.started);
  if (started?.["harness"] !== "pi") return undefined;
  const entry = await settledPiEntry(request);
  if (typeof entry === "string") return entry;
  const session = await ownedPiSession({
    ...request,
    entry,
    operationId: request.intent.operationId,
  });
  if (typeof session === "string") return session;
  const checkpoint = await piCheckpoint(session);
  if (typeof checkpoint === "string") return checkpoint;
  const required = requiredResponses(entry, session);
  return !checkpoint.hasConversation ||
    checkpoint.historicalResponses.length < required
    ? "pi-session-history-missing"
    : session;
}

function requiredResponses(
  entry: Readonly<Record<string, unknown>>,
  session: PiSession,
): number {
  const turns = typeof entry["turns"] === "number" ? entry["turns"] : 0;
  return (session.historicalResponses?.length ?? 0) + turns;
}

async function settledPiEntry(request: {
  readonly started: unknown;
  readonly folder: string;
}) {
  const attempt = attemptNumber(request.started);
  const entry = record(
    await readRecord(request.folder, `attempt-${String(attempt)}.json`),
  );
  if (entry === undefined) return "pi-prior-result-uncertain";
  const launch = recordedLaunch(entry["launch"]);
  if (
    typeof entry["endedAt"] !== "string" ||
    launch === undefined ||
    (await launchState(launch)) !== "ended"
  )
    return "pi-prior-result-uncertain";
  return entry;
}

export async function preparedPiSession(place: {
  readonly folder: string;
  readonly directory: string;
  readonly previous: PiSession | undefined;
}): Promise<PiSession | string> {
  try {
    await mkdir(place.folder, { recursive: true, mode: 0o700 });
    return (
      (await continuedPiSession(place.previous, place.folder)) ??
      (await createPiSession(place))
    );
  } catch (error) {
    return record(error)?.["code"] === "EEXIST"
      ? "pi-session-state-unowned"
      : "pi-session-state-unavailable";
  }
}

async function continuedPiSession(
  previous: PiSession | undefined,
  folder: string,
): Promise<PiSession | string | undefined> {
  if (previous === undefined) return undefined;
  const checkpoint = await piCheckpoint(previous);
  if (typeof checkpoint === "string") return checkpoint;
  const directory = join(folder, "pi-session");
  await mkdir(directory, { mode: 0o700 });
  const path = join(directory, "session.jsonl");
  await writeFile(path, checkpoint.text, { flag: "wx", mode: 0o600 });
  return {
    ...previous,
    path,
    historicalResponses: checkpoint.historicalResponses,
  };
}

async function piCheckpoint(session: PiSession) {
  try {
    const file = await open(
      session.path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      if (!(await file.stat()).isFile()) return "pi-session-state-invalid";
      const text = await file.readFile("utf8");
      if (!text.endsWith("\n")) return "pi-session-state-invalid";
      const lines = text.trimEnd().split("\n");
      const header = record(JSON.parse(lines[0] ?? ""));
      if (
        header?.["type"] !== "session" ||
        header["version"] !== 3 ||
        piSessionHeader({
          id: String(header["id"]),
          cwd: String(header["cwd"]),
          timestamp: String(header["timestamp"]),
        }) !== piSessionHeader(session)
      )
        return "pi-session-ownership-conflict";
      const historicalResponses = [
        ...new Set(lines.slice(1).flatMap(historicalResponse)),
      ];
      const hasConversation = lines.slice(1).some(conversationEntry);
      return { text, historicalResponses, hasConversation };
    } finally {
      await file.close();
    }
  } catch {
    return "pi-session-state-invalid";
  }
}

function conversationEntry(line: string): boolean {
  const entry = record(JSON.parse(line));
  const role = record(entry?.["message"])?.["role"];
  return (
    entry?.["type"] === "message" &&
    ["user", "assistant"].includes(String(role))
  );
}

function historicalResponse(line: string): readonly string[] {
  const entry = record(JSON.parse(line));
  const message = record(entry?.["message"]);
  if (entry?.["type"] !== "message" || message?.["role"] !== "assistant")
    return [];
  const identity = responseIdentity(message);
  return identity === undefined ? [] : [identity];
}

export async function consumePiShutdown(
  folder: string,
  plan: {
    readonly resume?: { readonly piSession?: PiSession };
    readonly attach?: unknown;
  },
): Promise<void> {
  if (plan.resume?.piSession === undefined) return;
  const result = record(await readRecord(folder, "result.json"));
  const attempt = attemptNumber(await readRecord(folder, "started.json"));
  await writeRecord(folder, {
    name: "result.json",
    value: { ...result, piResumeAttempt: attempt },
    permissions: "private",
  });
}

export function piResumeState(
  started: unknown,
  result: unknown,
): "attach" | "resume" | undefined {
  if (
    record(started)?.["harness"] !== "pi" ||
    record(result)?.["stoppedBy"] !== "daemon-shutdown"
  )
    return undefined;
  const source = record(result)?.["piResumeAttempt"];
  const attempt = attemptNumber(started);
  return typeof source === "number" && attempt !== undefined && attempt > source
    ? "attach"
    : "resume";
}
