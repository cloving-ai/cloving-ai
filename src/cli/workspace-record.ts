import { randomInt, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { record } from "../protocol.ts";
import { runtimeRoot } from "./runtime-directory.ts";

export interface WorkspaceMember {
  readonly name: string;
  readonly repository: string;
  readonly runtime: string;
}

export interface WorkspaceRecord {
  readonly processId: number;
  readonly members: readonly WorkspaceMember[];
}

export function workspaceRecordPath(
  environment: Readonly<NodeJS.ProcessEnv>,
): string | undefined {
  const root = runtimeRoot(environment);
  return root === undefined
    ? undefined
    : join(root, "cloving", "workspace", "supervisor.json");
}

export type WorkspaceClaim =
  | { readonly kind: "claimed" }
  | { readonly kind: "running"; readonly processId: number };

export async function writeWorkspaceRecord(
  path: string,
  written: WorkspaceRecord,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}`;
  await writeFile(
    temporary,
    `${JSON.stringify({ schemaVersion: 1, ...written })}\n`,
    { mode: 0o600 },
  );
  await rename(temporary, path);
}

function claimFolder(path: string): string {
  return join(dirname(path), "claims");
}

function claimOwner(name: string): number | undefined {
  const found = /^([1-9][0-9]*)\.[0-9a-f-]+$/.exec(name);
  return found === null ? undefined : processIdOf(Number(found[1]));
}

async function otherClaim(
  folder: string,
  own: string,
): Promise<number | undefined> {
  const others = (await readdir(folder)).filter((name) => name !== own);
  for (const name of others) {
    const owner = claimOwner(name);
    if (owner !== undefined && running(owner)) return owner;
    if (owner !== undefined) await rm(join(folder, name), { force: true });
  }
  return undefined;
}

function recordOwner(path: string, processId: number): number | undefined {
  const found = readRecord(path)?.processId;
  return found !== undefined && found !== processId && running(found)
    ? found
    : undefined;
}

interface Claiming {
  readonly path: string;
  readonly own: string;
  readonly claimed: WorkspaceRecord;
}

type Attempt =
  WorkspaceClaim | { readonly kind: "contended"; readonly processId: number };

async function claimAttempt(claiming: Claiming): Promise<Attempt> {
  const { path, own, claimed } = claiming;
  const owner = recordOwner(path, claimed.processId);
  if (owner !== undefined) return { kind: "running", processId: owner };
  const other = await otherClaim(dirname(own), basename(own));
  if (other !== undefined) return { kind: "contended", processId: other };
  await writeWorkspaceRecord(path, claimed);
  return { kind: "claimed" };
}

async function filedAttempt(claiming: Claiming): Promise<Attempt> {
  await writeFile(claiming.own, "", { flag: "wx", mode: 0o600 });
  const attempt = await claimAttempt(claiming).catch(async (error: unknown) => {
    await rm(claiming.own, { force: true });
    throw error;
  });
  if (attempt.kind !== "claimed") await rm(claiming.own, { force: true });
  return attempt;
}

const claimAttempts = 5;

export async function claimWorkspaceRecord(
  path: string,
  claimed: WorkspaceRecord,
): Promise<WorkspaceClaim> {
  const folder = claimFolder(path);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const own = join(folder, `${String(claimed.processId)}.${randomUUID()}`);
  let processId = 0;
  for (let attempt = 0; attempt < claimAttempts; attempt += 1) {
    const result = await filedAttempt({ path, own, claimed });
    if (result.kind !== "contended") return result;
    processId = result.processId;
    await delay(randomInt(10, 200));
  }
  return { kind: "running", processId };
}

function member(value: unknown): WorkspaceMember | undefined {
  const fields = record(value);
  const name = fields?.["name"];
  const repository = fields?.["repository"];
  const runtime = fields?.["runtime"];
  if (
    typeof name !== "string" ||
    typeof repository !== "string" ||
    typeof runtime !== "string"
  )
    return undefined;
  return { name, repository, runtime };
}

function running(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function parsedText(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
}

function processIdOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function storedRecord(text: string): WorkspaceRecord | undefined {
  const fields = record(parsedText(text));
  const processId = processIdOf(fields?.["processId"]);
  const listed = fields?.["members"];
  if (fields?.["schemaVersion"] !== 1 || processId === undefined)
    return undefined;
  if (!Array.isArray(listed) || listed.length === 0) return undefined;
  const members = Array.from<unknown>(listed).map(member);
  if (members.includes(undefined)) return undefined;
  return { processId, members: members.filter((item) => item !== undefined) };
}

function recordText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function readRecord(path: string): WorkspaceRecord | undefined {
  const text = recordText(path);
  return text === undefined ? undefined : storedRecord(text);
}

export function liveWorkspace(
  environment: Readonly<NodeJS.ProcessEnv>,
): WorkspaceRecord | undefined {
  const path = workspaceRecordPath(environment);
  if (path === undefined) return undefined;
  const found = readRecord(path);
  return found !== undefined && running(found.processId) ? found : undefined;
}

export async function removeWorkspaceRecord(
  path: string,
  processId: number,
): Promise<void> {
  if (readRecord(path)?.processId === processId)
    await rm(path, { force: true });
  const folder = claimFolder(path);
  const names = await readdir(folder).catch(() => []);
  await Promise.all(
    names
      .filter((name) => claimOwner(name) === processId)
      .map((name) => rm(join(folder, name), { force: true })),
  );
}

export function memberDirectory(
  workspace: WorkspaceRecord | undefined,
  selected: string | undefined,
): string | undefined {
  return (
    workspace?.members.find((item) => item.name === selected)?.repository ??
    selected
  );
}
