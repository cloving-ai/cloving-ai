import { access, readdir, readFile, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { record, type Fields } from "../src/protocol.ts";
import {
  attemptNumber,
  connectableTurn,
  recordedLaunch,
} from "../src/turn-launch.ts";
import { heldWork, type KeepReads, type WorkReads } from "../src/work-gap.ts";

interface ActivitySettings {
  readonly directory: string;
  readonly runtimeDirectory: string;
  readonly signal?: AbortSignal;
}

async function runPage(
  settings: ActivitySettings,
  after: string,
): Promise<Fields> {
  const output = await promisify(execFile)(
    process.execPath,
    [
      join(import.meta.dirname, `../src/cli${extname(import.meta.filename)}`),
      "status",
      "--json",
      "--limit",
      "500",
      ...(after === "" ? [] : ["--after", after]),
    ],
    {
      env: { ...process.env, CLOVING_RUNTIME_DIR: settings.runtimeDirectory },
      encoding: "utf8",
      timeout: 30000,
      signal: settings.signal,
    },
  );
  const page = record(JSON.parse(output.stdout));
  if (!page) throw new Error("invalid-run-list");
  return page;
}

export function hostWorkReads(
  settings: ActivitySettings,
): WorkReads & KeepReads {
  const { directory } = settings;
  return {
    runPage: (after) => runPage(settings, after),
    openTurn: () => workerTurnActive(directory),
    heldTurn: () => heldTurnActive(directory),
    heldCommand: () => heldCommandActive(directory),
    pendingSubmission: () => present(join(directory, "queue-submission")),
  };
}

export async function selfUpdateActive(
  settings: ActivitySettings,
): Promise<boolean> {
  return (await heldWork(hostWorkReads(settings))).length > 0;
}

export async function selfUpdateMilliseconds(settings: {
  readonly seconds: string | undefined;
  readonly repository: string;
  readonly product: string;
}): Promise<number | undefined> {
  const { seconds } = settings;
  if (seconds === undefined) return;
  const value = Number(seconds);
  if (
    !/^\d+$/.test(seconds) ||
    !Number.isInteger(value) ||
    value < 30 ||
    value > 3600
  )
    throw new Error("The daemon did not start: invalid-self-update-seconds");
  if (
    (await realpath(settings.repository)) !== (await realpath(settings.product))
  )
    throw new Error(
      "The daemon did not start: self-update-needs-own-repository",
    );
  return value * 1000;
}

async function present(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}

async function openEntries(folder: string): Promise<readonly string[]> {
  if (!(await present(folder))) return [];
  const open: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const place = join(folder, entry.name);
    if (
      (await present(join(place, "started.json"))) &&
      !(await present(join(place, "result.json")))
    )
      open.push(place);
  }
  return open;
}

export async function workerTurnActive(directory: string): Promise<boolean> {
  return (await openEntries(join(directory, "journal"))).length > 0;
}

async function jsonIn(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

async function keptTurn(folder: string): Promise<boolean> {
  const started = await jsonIn(join(folder, "started.json"));
  const attempt = attemptNumber(started);
  if (attempt === undefined) return false;
  const entry = await jsonIn(join(folder, `attempt-${String(attempt)}.json`));
  return connectableTurn({ started, entry });
}

async function heldTurnActive(directory: string): Promise<boolean> {
  for (const folder of await openEntries(join(directory, "journal")))
    if (!(await keptTurn(folder))) return true;
  return false;
}

async function heldCommandActive(directory: string): Promise<boolean> {
  for (const folder of await openEntries(join(directory, "commands")))
    if (recordedLaunch(await jsonIn(join(folder, "launch.json"))) === undefined)
      return true;
  return false;
}
