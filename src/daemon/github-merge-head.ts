import { dirname, join } from "node:path";
import { operationKey, readRecord, writeRecord } from "./operation-journal.ts";
import { field, type Operation } from "./github-operation.ts";

export interface UpdatedHead {
  readonly commit: string;
  readonly updated: string;
}

const name = "updated-head.json";

function targetRecord(operation: Operation) {
  return {
    folder: join(dirname(operation.folder), "targets"),
    name: `${operationKey(operation.target)}.json`,
  };
}

function checkedHead(record: unknown, commit: string): string {
  const updated = field(record, "updated");
  if (
    field(record, "commit") !== commit ||
    typeof updated !== "string" ||
    !/^[0-9a-f]{40,64}$/.test(updated)
  )
    throw new Error("git-call-failed");
  return updated;
}

export async function recordedHead(
  operation: Operation,
  commit: string,
): Promise<string | undefined> {
  const record = await readRecord(operation.folder, name);
  if (record !== undefined) return checkedHead(record, commit);
  const target = targetRecord(operation);
  const saved = await readRecord(target.folder, target.name);
  if (field(saved, "commit") !== commit) return undefined;
  return checkedHead(saved, commit);
}

export async function savedHead(
  operation: Operation,
  head: UpdatedHead,
): Promise<void> {
  await writeRecord(operation.folder, { name, value: head });
  const target = targetRecord(operation);
  await writeRecord(target.folder, { name: target.name, value: head });
}
