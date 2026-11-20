import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface LegacyWorldRefusal {
  readonly kind: "refused";
  readonly reason: "legacy-world-runs";
  readonly detail: string;
}

interface LegacyRun {
  readonly worldRunId: string;
  readonly runId: string | undefined;
  readonly status: string;
}

const finishedStatuses = ["completed", "failed", "cancelled"];

function field(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return Reflect.get(value, name);
}

function text(value: unknown, name: string): string | undefined {
  const stored = field(value, name);
  return typeof stored === "string" ? stored : undefined;
}

function parsed(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    return undefined;
  }
}

async function runNames(folder: string): Promise<readonly string[]> {
  try {
    return (await readdir(folder))
      .filter((name) => name.endsWith(".json"))
      .toSorted();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return [];
    throw error;
  }
}

async function legacyRun(folder: string, name: string): Promise<LegacyRun> {
  const stored = parsed(await readFile(join(folder, name), "utf8"));
  return {
    worldRunId: name.slice(0, -".json".length),
    runId: text(field(stored, "attributes"), "cloving.run"),
    status: text(stored, "status") ?? "unreadable",
  };
}

function described(run: LegacyRun): string {
  const world = `World run ${run.worldRunId}`;
  if (run.runId === undefined) return `${world} (${run.status})`;
  return `${run.runId} (${world}, ${run.status})`;
}

export async function legacyWorldRefusal(
  dataDirectory: string,
): Promise<LegacyWorldRefusal | undefined> {
  const folder = join(dataDirectory, "runs");
  const unfinished: LegacyRun[] = [];
  for (const name of await runNames(folder)) {
    const run = await legacyRun(folder, name);
    if (!finishedStatuses.includes(run.status)) unfinished.push(run);
  }
  if (unfinished.length === 0) return undefined;
  return {
    kind: "refused",
    reason: "legacy-world-runs",
    detail: `The Local World folder ${dataDirectory} holds runs of an earlier Workflow SDK that are not finished: ${unfinished.map(described).join(", ")}. This release keeps World data in world.db and does not read these runs. To drain them, start the earlier Cloving release with the same state, let each run finish or drop it with "cloving drop <run-id>", stop that service, then start this release again. The finished runs stay in the folder.`,
  };
}
