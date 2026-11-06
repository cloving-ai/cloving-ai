import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { send } from "../cli/client.ts";
import { operationScope } from "../operation-identity.ts";
import { record, type Fields } from "../protocol.ts";
import { readRecord } from "./operation-journal.ts";

const finishedEntries = new Map<string, ReadonlySet<string>>();

function noEntries(error: unknown): readonly string[] {
  if (error instanceof Error && "code" in error && error.code === "ENOENT")
    return [];
  throw error;
}

async function finished(folder: string): Promise<boolean> {
  return access(join(folder, "result.json")).then(
    () => true,
    () => false,
  );
}

async function startedRun(folder: string): Promise<string | undefined> {
  const started = record(await readRecord(folder, "started.json"));
  if (started === undefined) return undefined;
  const { runId, operationId } = started;
  if (typeof runId === "string") return runId;
  return typeof operationId === "string"
    ? (operationScope(operationId)?.run ?? undefined)
    : undefined;
}

export async function openRuns(journal: string): Promise<ReadonlySet<string>> {
  const names = await readdir(journal).catch(noEntries);
  const known = finishedEntries.get(journal);
  const entries = await Promise.all(
    names.map(async (name) => ({
      name,
      finished:
        known?.has(name) === true || (await finished(join(journal, name))),
    })),
  );
  finishedEntries.set(
    journal,
    new Set(entries.filter((entry) => entry.finished).map(({ name }) => name)),
  );
  const runs = await Promise.all(
    entries
      .filter((entry) => !entry.finished)
      .map(({ name }) => startedRun(join(journal, name))),
  );
  return new Set(runs.filter((run) => run !== undefined));
}

function busyRunIdsOf(value: unknown): ReadonlySet<string> {
  const listed = record(value)?.["busyRunIds"];
  if (
    !Array.isArray(listed) ||
    !listed.every((runId: unknown) => typeof runId === "string")
  )
    throw new Error("invalid-queue-status");
  return new Set(listed);
}

function pageRuns(result: Fields): Fields[] {
  const page = result["runs"];
  if (!Array.isArray(page)) throw new Error("invalid-run-list");
  return page.map(record).filter((run) => run !== undefined);
}

function nextPage(result: Fields, after: string): string | null {
  const next = result["next"];
  if (next !== null && (typeof next !== "string" || next <= after))
    throw new Error("invalid-run-page");
  return next;
}

async function busyRuns(runtimeDirectory: string): Promise<Fields[]> {
  const runs: Fields[] = [];
  let busy: ReadonlySet<string> | undefined;
  let after: string | null = "";
  do {
    const reply = await send(runtimeDirectory, {
      operation: "status",
      parameters: { after, limit: 500, active: true },
    });
    if (reply.kind === "error") throw new Error(reply.error.code);
    const page = pageRuns(reply.result);
    busy ??= busyRunIdsOf(reply.result["queue"]);
    runs.push(...page.filter((run) => busy?.has(String(run["runId"]))));
    after = nextPage(reply.result, after);
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
}): Promise<number> {
  const [turns, commands, github] = await Promise.all(
    ["journal", "commands", "github"].map((folder) =>
      openRuns(join(settings.directory, folder)),
    ),
  );
  const runs = await busyRuns(settings.runtimeDirectory);
  return runs.filter((run) => {
    const runId = String(run["runId"]);
    if (turns?.has(runId) === true || commands?.has(runId) === true)
      return false;
    return (
      github?.has(runId) === true ||
      waitsForPerson(run) ||
      typeof run["awaitedRunId"] === "string"
    );
  }).length;
}
