import { piRpcOwnershipFailure } from "./pi-rpc-channel.ts";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { record } from "../protocol.ts";
import { attemptNumber, recordedLaunch } from "../turn-launch.ts";
import { readRecord } from "./operation-journal.ts";

export interface PiSession {
  readonly historicalResponses?: readonly string[];
  readonly historicalTools?: readonly string[];
  readonly path: string;
  readonly id: string;
  readonly cwd: string;
  readonly timestamp: string;
}

export function piSessionCommandFailure(
  command: readonly string[],
): string | undefined {
  const selectors = [
    "--continue",
    "-c",
    "--resume",
    "-r",
    "--session",
    "--session-id",
    "--session-dir",
    "--fork",
    "--no-session",
    "--",
  ];
  return command.some((part) => selectors.includes(part.split("=")[0] ?? ""))
    ? "pi-session-command-unsupported"
    : undefined;
}

export function piRpcCommand(
  command: readonly string[],
): readonly string[] | undefined {
  const values = new Set([
    "--mode",
    "--model",
    "-m",
    "--provider",
    "--thinking",
    "--session",
  ]);
  const parts = [...command];
  let modes = 0;
  for (let index = 1; index < parts.length; index += 2) {
    const flag = parts[index] ?? "";
    const value = parts[index + 1];
    if (!values.has(flag) || value === undefined || value.startsWith("-"))
      return undefined;
    if (flag !== "--mode") continue;
    if (!["json", "rpc"].includes(value)) return undefined;
    modes += 1;
    parts[index + 1] = "rpc";
  }
  return modes === 1 ? parts : undefined;
}

export async function createPiSession(place: {
  readonly folder: string;
  readonly directory: string;
}): Promise<PiSession | string> {
  try {
    const folder = join(place.folder, "pi-session");
    await mkdir(folder, { mode: 0o700 });
    const session = {
      path: join(folder, "session.jsonl"),
      id: randomUUID(),
      cwd: place.directory,
      timestamp: new Date().toISOString(),
    };
    const { path, ...identity } = session;
    await writeFile(
      path,
      JSON.stringify({ type: "session", version: 3, ...identity }) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    return session;
  } catch (error) {
    return record(error)?.["code"] === "EEXIST"
      ? "pi-session-state-unowned"
      : "pi-session-state-unavailable";
  }
}

async function sessionHeader(path: string): Promise<unknown> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!(await file.stat()).isFile()) return "pi-session-state-invalid";
    const buffer = Buffer.alloc(16_384);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const newline = text.indexOf("\n");
    return newline < 0 ? undefined : JSON.parse(text.slice(0, newline));
  } finally {
    await file.close();
  }
}

function sameSession(
  first: Readonly<Record<string, unknown>>,
  second: unknown,
): boolean {
  const fields = record(second);
  if (fields === undefined) return false;
  return [
    "path",
    "id",
    "cwd",
    "timestamp",
    "historicalResponses",
    "historicalTools",
  ].every(
    (name) => JSON.stringify(first[name]) === JSON.stringify(fields[name]),
  );
}

function validSession(session: Readonly<Record<string, unknown>>): boolean {
  const texts = ["path", "id", "cwd", "timestamp"].every(
    (name) => typeof session[name] === "string" && session[name] !== "",
  );
  const timestamp = session["timestamp"];
  return (
    texts &&
    ["historicalResponses", "historicalTools"].every((key) => {
      const values = session[key];
      return (
        values === undefined ||
        (Array.isArray(values) &&
          values.every((value: unknown) => typeof value === "string"))
      );
    }) &&
    typeof timestamp === "string" &&
    Number.isFinite(Date.parse(timestamp))
  );
}

async function sessionDirectory(
  place: string,
  path: string,
): Promise<string | undefined> {
  const expected = join(await realpath(place), "pi-session");
  const actual = await realpath(dirname(path)).catch(() => undefined);
  if (actual === undefined) return "pi-session-state-missing";
  return expected === actual ? undefined : "pi-session-ownership-conflict";
}

function headerFailure(
  header: unknown,
  session: Readonly<Record<string, unknown>>,
): string | undefined {
  const fields = record(header);
  if (fields === undefined) return "pi-session-state-invalid";
  return fields["type"] === "session" &&
    fields["version"] === 3 &&
    ["id", "cwd", "timestamp"].every((name) => fields[name] === session[name])
    ? undefined
    : "pi-session-ownership-conflict";
}

interface SessionRequest {
  readonly started: unknown;
  readonly entry: Readonly<Record<string, unknown>>;
  readonly folder: string;
  readonly operationId: string;
}

function sessionOwnership(request: SessionRequest) {
  const { folder, operationId, entry } = request;
  const started = record(request.started) ?? {};
  const session = record(started["piSession"]) ?? {};
  const path = session["path"];
  if (typeof path !== "string") return "pi-session-state-missing";
  if (!validSession(session)) return "pi-session-state-invalid";
  const attempt = entry["attempt"];
  const place =
    attempt === 1 ? folder : join(folder, `attempt-${String(attempt)}`);
  if (
    path !== join(place, "pi-session", "session.jsonl") ||
    started["operationId"] !== operationId ||
    !sameSession(session, entry["piSession"]) ||
    session["cwd"] !== started["worktree"]
  )
    return "pi-session-ownership-conflict";
  return { place, session, path };
}

export function piOperationRefusal(
  started: unknown,
  request: {
    readonly key: string;
    readonly intent: { readonly operationId: string; readonly target?: string };
  },
): { readonly kind: "unknown"; readonly evidence: string } | undefined {
  const fields = record(started) ?? {};
  if (fields["harness"] !== "pi") return undefined;
  const { intent, key } = request;
  if (
    fields["operationId"] === intent.operationId &&
    fields["target"] === intent.target
  )
    return undefined;
  return { kind: "unknown", evidence: `pi-session-ownership-conflict:${key}` };
}

export async function piOperationRecord(
  folder: string,
  active:
    | {
        readonly worker: string;
        readonly intent: {
          readonly operationId: string;
          readonly target?: string;
        };
      }
    | undefined,
): Promise<unknown> {
  return active === undefined
    ? readRecord(folder, "started.json")
    : { harness: active.worker, ...active.intent };
}

export async function piAttemptRefusal(
  folder: string,
  started: unknown,
): Promise<string | undefined> {
  const fields = record(started);
  if (fields?.["harness"] !== "pi" || fields["phase"] !== "running")
    return undefined;
  const attempt = attemptNumber(started);
  if (attempt === undefined) return "pi-attempt-ownership-conflict";
  const value = await readRecord(
    folder,
    `attempt-${String(attempt)}.json`,
  ).catch(() => null);
  if (value === undefined) return "pi-attempt-state-missing";
  const entry = record(value);
  if (entry === undefined) return "pi-attempt-state-invalid";
  return piAttemptEvidenceFailure(fields, entry);
}

function piAttemptEvidenceFailure(
  started: Readonly<Record<string, unknown>>,
  entry: Readonly<Record<string, unknown>>,
): string | undefined {
  const keys = [
    "attempt",
    "harness",
    "operationId",
    "target",
    "worktree",
    "processId",
    "startCommit",
    "turnStartCommit",
  ];
  if (keys.some((name) => started[name] !== entry[name]))
    return "pi-attempt-ownership-conflict";
  const launch = recordedLaunch(started["launch"]);
  if (launch === undefined) return "pi-prior-result-uncertain";
  const rpcFailure = piRpcOwnershipFailure(launch, entry["piSession"]);
  if (rpcFailure !== undefined) return rpcFailure;
  return JSON.stringify(launch) ===
    JSON.stringify(recordedLaunch(entry["launch"]))
    ? undefined
    : "pi-attempt-ownership-conflict";
}

export async function ownedPiSession(
  request: SessionRequest,
): Promise<string | PiSession> {
  const ownership = sessionOwnership(request);
  if (typeof ownership === "string") return ownership;
  const { place, session, path } = ownership;
  const directoryFailure = await sessionDirectory(place, path);
  if (directoryFailure !== undefined) return directoryFailure;
  const value = await sessionHeader(path).catch((error: unknown) => {
    if (record(error)?.["code"] === "ENOENT") return "pi-session-state-missing";
    if (record(error)?.["code"] === "ELOOP")
      return "pi-session-ownership-conflict";
    return "pi-session-state-invalid";
  });
  if (typeof value === "string") return value;
  const failure = headerFailure(value, session);
  if (failure !== undefined) return failure;
  const historicalResponses = session["historicalResponses"];
  const historicalTools = session["historicalTools"];
  return {
    ...(Array.isArray(historicalResponses)
      ? { historicalResponses: historicalResponses.map(String) }
      : {}),
    ...(Array.isArray(historicalTools)
      ? { historicalTools: historicalTools.map(String) }
      : {}),
    path,
    id: String(session["id"]),
    cwd: String(session["cwd"]),
    timestamp: String(session["timestamp"]),
  };
}
