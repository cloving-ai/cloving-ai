import { access, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { send } from "../cli/client.ts";
import { operationScope } from "../operation-identity.ts";
import { record, type Fields } from "../protocol.ts";
import type { Calls } from "./github-calls.ts";
import { readRecord, writeRecord } from "./operation-journal.ts";

interface FolderScan {
  readonly finished: ReadonlySet<string>;
  readonly started: ReadonlyMap<string, string | null>;
}

interface Entry {
  readonly name: string;
  readonly finished: boolean;
  readonly runId: string | null | undefined;
}

export interface OpenWork {
  readonly working: ReadonlySet<string>;
  readonly github: ReadonlySet<string>;
}

const checkRecord = "checking.json";
const scans = new Map<string, FolderScan>();
const noScan: FolderScan = { finished: new Set(), started: new Map() };

function noEntries(error: unknown): readonly string[] {
  if (error instanceof Error && "code" in error && error.code === "ENOENT")
    return [];
  throw error;
}

async function present(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function startedRun(folder: string): Promise<string | null | undefined> {
  const started = record(await readRecord(folder, "started.json"));
  if (started === undefined) return undefined;
  const { runId, operationId } = started;
  if (typeof runId === "string") return runId;
  return typeof operationId === "string"
    ? (operationScope(operationId)?.run ?? null)
    : null;
}

async function entryOf(
  journal: string,
  entry: { readonly name: string; readonly known: FolderScan },
): Promise<Entry> {
  const { name, known } = entry;
  const folder = join(journal, name);
  if (known.finished.has(name) || (await present(join(folder, "result.json"))))
    return { name, finished: true, runId: undefined };
  const runId = known.started.has(name)
    ? known.started.get(name)
    : await startedRun(folder);
  return { name, finished: false, runId };
}

async function openEntries(
  journal: string,
): Promise<ReadonlyMap<string, string>> {
  const names = await readdir(journal).catch(noEntries);
  const known = scans.get(journal) ?? noScan;
  const entries = await Promise.all(
    names.map((name) => entryOf(journal, { name, known })),
  );
  const open = entries.filter((entry) => !entry.finished);
  scans.set(journal, {
    finished: new Set(
      entries.filter((entry) => entry.finished).map(({ name }) => name),
    ),
    started: new Map(
      open.flatMap(({ name, runId }) =>
        runId === undefined ? [] : [[name, runId] as const],
      ),
    ),
  });
  return new Map(
    open.flatMap(({ name, runId }) =>
      typeof runId === "string" ? [[name, runId] as const] : [],
    ),
  );
}

export async function openRuns(journal: string): Promise<ReadonlySet<string>> {
  return new Set((await openEntries(journal)).values());
}

export function markedCalls(calls: Calls, folder: string): Calls {
  return {
    ...calls,
    run: async (command, directory) => {
      await writeRecord(folder, {
        name: checkRecord,
        value: { startedAt: new Date().toISOString() },
      });
      try {
        return await calls.run(command, directory);
      } finally {
        await rm(join(folder, checkRecord), { force: true });
      }
    },
  };
}

export async function openWork(directory: string): Promise<OpenWork> {
  const [turns, commands, github] = await Promise.all([
    openEntries(join(directory, "journal")),
    openEntries(join(directory, "commands")),
    openEntries(join(directory, "github")),
  ]);
  const checks = await Promise.all(
    [...github].map(async ([name, runId]) =>
      (await present(join(directory, "github", name, checkRecord)))
        ? [runId]
        : [],
    ),
  );
  return {
    working: new Set([
      ...turns.values(),
      ...commands.values(),
      ...checks.flat(),
    ]),
    github: new Set(github.values()),
  };
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
  const work = await openWork(settings.directory);
  const runs = await busyRuns(settings.runtimeDirectory);
  return runs.filter((run) => {
    const runId = String(run["runId"]);
    if (work.working.has(runId)) return false;
    return (
      work.github.has(runId) ||
      waitsForPerson(run) ||
      typeof run["awaitedRunId"] === "string"
    );
  }).length;
}
