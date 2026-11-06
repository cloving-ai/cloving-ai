import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { send } from "../cli/client.ts";
import { operationScope } from "../operation-identity.ts";
import { record, type Fields } from "../protocol.ts";
import { readRecord } from "./operation-journal.ts";

function noEntries(error: unknown): readonly string[] {
  if (error instanceof Error && "code" in error && error.code === "ENOENT")
    return [];
  throw error;
}

async function openRun(folder: string): Promise<string | undefined> {
  const started = record(await readRecord(folder, "started.json"));
  if (started === undefined) return undefined;
  if ((await readRecord(folder, "result.json")) !== undefined) return undefined;
  const { runId, operationId } = started;
  if (typeof runId === "string") return runId;
  return typeof operationId === "string"
    ? (operationScope(operationId)?.run ?? undefined)
    : undefined;
}

export async function openRuns(journal: string): Promise<ReadonlySet<string>> {
  const names = await readdir(journal).catch(noEntries);
  const runs = await Promise.all(
    names.map((name) => openRun(join(journal, name))),
  );
  return new Set(runs.filter((run) => run !== undefined));
}

async function activeRuns(runtimeDirectory: string): Promise<Fields[]> {
  const runs: Fields[] = [];
  let after: string | null = "";
  do {
    const reply = await send(runtimeDirectory, {
      operation: "status",
      parameters: { after, limit: 500, active: true },
    });
    if (reply.kind === "error") throw new Error(reply.error.code);
    const page = reply.result["runs"];
    if (!Array.isArray(page)) throw new Error("invalid-run-list");
    for (const run of page.map(record)) if (run !== undefined) runs.push(run);
    const next = reply.result["next"];
    if (next !== null && (typeof next !== "string" || next <= after))
      throw new Error("invalid-run-page");
    after = next;
  } while (after !== null);
  return runs;
}

function waitsForPerson(run: Fields): boolean {
  const decisions = run["pendingDecisions"];
  return (
    run["state"] === "waiting_gate" ||
    (Array.isArray(decisions) && decisions.length > 0)
  );
}

export async function waitingRuns(settings: {
  readonly directory: string;
  readonly runtimeDirectory: string;
  readonly workflowId: string;
}): Promise<number> {
  const [turns, commands, github] = await Promise.all(
    ["journal", "commands", "github"].map((folder) =>
      openRuns(join(settings.directory, folder)),
    ),
  );
  const runs = await activeRuns(settings.runtimeDirectory);
  return runs.filter((run) => {
    const runId = String(run["runId"]);
    if (run["workflowId"] !== settings.workflowId) return false;
    if (turns?.has(runId) === true || commands?.has(runId) === true)
      return false;
    return (
      github?.has(runId) === true ||
      waitsForPerson(run) ||
      typeof run["awaitedRunId"] === "string"
    );
  }).length;
}
