import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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

async function temporaryRecord(
  path: string,
  written: WorkspaceRecord,
): Promise<string> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}`;
  await writeFile(
    temporary,
    `${JSON.stringify({ schemaVersion: 1, ...written })}\n`,
    { mode: 0o600 },
  );
  return temporary;
}

export async function writeWorkspaceRecord(
  path: string,
  written: WorkspaceRecord,
): Promise<void> {
  await rename(await temporaryRecord(path, written), path);
}

function linked(temporary: string, path: string): Promise<boolean> {
  return link(temporary, path).then(
    () => true,
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "EEXIST")
        return false;
      throw error;
    },
  );
}

function recordText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

async function staleRemoved(
  path: string,
  seen: string | undefined,
): Promise<void> {
  const moved = `${path}.${randomUUID()}.stale`;
  const renamed = await rename(path, moved).then(
    () => true,
    () => false,
  );
  if (!renamed) return;
  const text = await readFile(moved, "utf8").catch(() => undefined);
  if (text !== seen) await linked(moved, path);
  await rm(moved, { force: true });
}

const claimAttempts = 3;

export async function claimWorkspaceRecord(
  path: string,
  claimed: WorkspaceRecord,
): Promise<WorkspaceClaim> {
  const temporary = await temporaryRecord(path, claimed);
  let processId = 0;
  try {
    for (let attempt = 0; attempt < claimAttempts; attempt += 1) {
      if (await linked(temporary, path)) return { kind: "claimed" };
      const seen = recordText(path);
      const found = seen === undefined ? undefined : storedRecord(seen);
      processId = found?.processId ?? processId;
      if (found !== undefined && running(found.processId))
        return { kind: "running", processId: found.processId };
      await staleRemoved(path, seen);
    }
    return { kind: "running", processId };
  } finally {
    await rm(temporary, { force: true });
  }
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
