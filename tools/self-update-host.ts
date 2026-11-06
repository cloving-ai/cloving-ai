import { access, readdir, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { record, type Fields } from "../src/protocol.ts";
import { atGap, workInProgress, type WorkReads } from "../src/work-gap.ts";

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

export function hostWorkReads(settings: ActivitySettings): WorkReads {
  return {
    runPage: (after) => runPage(settings, after),
    openTurn: () => workerTurnActive(settings.directory),
    pendingSubmission: () =>
      present(join(settings.directory, "queue-submission")),
  };
}

export async function selfUpdateActive(
  settings: ActivitySettings,
): Promise<boolean> {
  return !atGap(await workInProgress(hostWorkReads(settings)));
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

export async function workerTurnActive(directory: string): Promise<boolean> {
  const journal = join(directory, "journal");
  if (!(await present(journal))) return false;
  for (const entry of await readdir(journal, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const turn = join(journal, entry.name);
    if (
      (await present(join(turn, "started.json"))) &&
      !(await present(join(turn, "result.json")))
    )
      return true;
  }
  return false;
}
