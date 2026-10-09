import { readFile, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { hookRecord } from "./worker-hook-input.ts";
import type { WorkerHookEvent, WorkerHookPolicy } from "./worker-hook-input.ts";

export async function workerEditFile(
  file: string,
  policy: WorkerHookPolicy,
): Promise<string> {
  const workspace = await realpath(policy.workspace);
  const target = resolve(workspace, file);
  if (!policy.editableFiles.includes(relative(workspace, target)))
    throw new Error("outside-worker-edit-scope");
  let existing = target;
  for (;;) {
    try {
      if ((await realpath(existing)) !== existing)
        throw new Error("worker-edit-alias");
      return target;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
      if (existing === workspace) throw error;
      existing = dirname(existing);
    }
  }
}

export async function proposedWorkerText(
  event: Exclude<WorkerHookEvent, { event: "Stop" }>,
  file: string,
): Promise<string> {
  if (event.tool === "Write") {
    const content = event.input["content"];
    if (typeof content !== "string") throw new Error("invalid-worker-write");
    return content;
  }
  let source = await readFile(file, "utf8");
  const edits =
    event.tool === "MultiEdit" ? event.input["edits"] : [event.input];
  if (!Array.isArray(edits) || edits.length === 0)
    throw new Error("invalid-worker-edits");
  for (const edit of edits) source = applyWorkerEdit(source, edit);
  return source;
}

function applyWorkerEdit(source: string, value: unknown): string {
  if (
    !hookRecord(value) ||
    typeof value["old_string"] !== "string" ||
    value["old_string"].length === 0 ||
    typeof value["new_string"] !== "string"
  )
    throw new Error("invalid-worker-edit");
  if (!new Set<unknown>([undefined, true, false]).has(value["replace_all"]))
    throw new Error("invalid-worker-edit");
  const original = value["old_string"];
  const replacement = value["new_string"];
  const index = source.indexOf(original);
  if (
    index < 0 ||
    (!value["replace_all"] &&
      source.indexOf(original, index + original.length) >= 0)
  )
    throw new Error("ambiguous-worker-edit");
  if (value["replace_all"]) return source.split(original).join(replacement);
  return (
    source.slice(0, index) + replacement + source.slice(index + original.length)
  );
}
