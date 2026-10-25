import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readRetainedWorkflowBundle } from "./workflow-bundles.ts";

interface RuntimeSelection {
  readonly runtime: string;
  readonly repository: string;
  readonly legacyRuntime: string | undefined;
  readonly adoptionRecord: string | undefined;
}

export async function adoptRuntimeDirectory(
  input: RuntimeSelection,
): Promise<{ readonly runtime: string; readonly note: string }> {
  const { runtime, repository, legacyRuntime, adoptionRecord } = input;
  if (
    legacyRuntime === undefined ||
    adoptionRecord === undefined ||
    runtime === legacyRuntime
  )
    return { runtime, note: "" };
  const directory = join(dirname(legacyRuntime), "workflow-bundles");
  if (!(await belongsToRepository(directory, repository)))
    return {
      runtime,
      note: `Legacy runtime ${legacyRuntime} was not adopted: retained bundles are absent, damaged or belong to another repository.`,
    };
  await mkdir(dirname(adoptionRecord), { recursive: true, mode: 0o700 });
  const contents = JSON.stringify({
    schemaVersion: 1,
    repository,
    runtimeDirectory: legacyRuntime,
  });
  await writeFile(adoptionRecord, contents, { flag: "wx", mode: 0o600 });
  return { runtime: legacyRuntime, note: "" };
}

async function belongsToRepository(
  directory: string,
  repository: string,
): Promise<boolean> {
  try {
    const ids = (await readdir(directory)).filter((id) => id !== ".history");
    if (ids.length === 0) return false;
    for (const id of ids)
      if (
        (await readRetainedWorkflowBundle({ directory, repository, id }))
          .kind !== "available"
      )
        return false;
    return true;
  } catch {
    return false;
  }
}
