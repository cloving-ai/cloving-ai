import { access, readdir, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { record, type Fields } from "../src/protocol.ts";

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

export async function selfUpdateActive(
  settings: ActivitySettings,
): Promise<boolean> {
  if (await present(join(settings.directory, "queue-submission"))) return true;
  if (await workerTurnActive(settings.directory)) return true;
  let after: string | null = "";
  do {
    const page = await runPage(settings, after);
    const runs = page["runs"];
    if (!Array.isArray(runs)) throw new Error("invalid-run-list");
    if (
      runs.some((value: unknown) => {
        const run = record(value);
        if (!run) throw new Error("invalid-run-status");
        return !["completed", "failed", "cancelled"].includes(
          String(run["state"]),
        );
      })
    )
      return true;
    const next = page["next"];
    if (next !== null && (typeof next !== "string" || next <= after))
      throw new Error("invalid-run-page");
    after = next;
  } while (after !== null);
  return false;
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
