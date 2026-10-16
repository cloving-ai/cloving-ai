import { access, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";

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
