import { execFile } from "node:child_process";
import { access, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SelfUpdate } from "./self-update.ts";

const execute = promisify(execFile);

function absent(error: unknown): boolean {
  if (error instanceof Error && "code" in error && error.code === "ENOENT")
    return true;
  throw error;
}

async function present(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    (error: unknown) => !absent(error),
  );
}

async function activeTurn(directory: string): Promise<boolean> {
  const journal = join(directory, "journal");
  const entries = await readdir(journal, { withFileTypes: true }).catch(
    (error: unknown) => {
      absent(error);
      return [];
    },
  );
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folder = join(journal, entry.name);
    if (
      (await present(join(folder, "started.json"))) &&
      !(await present(join(folder, "result.json")))
    )
      return true;
  }
  return false;
}

export async function selfUpdateInterval(
  value: string | undefined,
  locations: {
    readonly repository: string;
    readonly product: string;
  },
): Promise<number | undefined> {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (
    !/^\d+$/.test(value) ||
    !Number.isInteger(seconds) ||
    seconds < 30 ||
    seconds > 3600
  )
    throw new Error("The daemon did not start: invalid-self-update-seconds");
  if (
    (await realpath(locations.repository)) !==
    (await realpath(locations.product))
  )
    throw new Error(
      "The daemon did not start: self-update-needs-own-repository",
    );
  return seconds * 1000;
}

export function localSelfUpdate(settings: {
  readonly directory: string;
  readonly repository: string;
}): Omit<SelfUpdate, "stop"> {
  const failures = join(settings.directory, "self-update-failures");
  return {
    git: async (argumentsList) =>
      (
        await execute("git", ["-C", settings.repository, ...argumentsList], {
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        })
      ).stdout.trim(),
    activeTurn: () => activeTurn(settings.directory),
    failed: (commit) => present(join(failures, commit)),
    recordFailure: async (commit) => {
      await mkdir(failures, { recursive: true });
      await writeFile(join(failures, commit), "");
    },
    report: (message) => process.stderr.write(message + "\n"),
  };
}
