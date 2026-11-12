import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { send } from "./client.ts";
import type { WorkReads } from "../work-gap.ts";

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function found(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

async function turnOpen(directory: string): Promise<boolean> {
  const journal = join(directory, "journal");
  const entries = await readdir(journal, { withFileTypes: true }).catch(
    (error: unknown) => {
      if (missing(error)) return [];
      throw error;
    },
  );
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const turn = join(journal, entry.name);
    if (!(await found(join(turn, "started.json")))) continue;
    if (!(await found(join(turn, "result.json")))) return true;
  }
  return false;
}

async function pendingSubmission(directory: string): Promise<boolean> {
  if (await found(join(directory, "queue-submission"))) return true;
  const queues = join(directory, "queues");
  const entries = await readdir(queues, { withFileTypes: true }).catch(
    (error: unknown) => {
      if (missing(error)) return [];
      throw error;
    },
  );
  return (
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => found(join(queues, entry.name, "queue-submission"))),
    )
  ).includes(true);
}

export function daemonWorkReads(settings: {
  readonly directory: string;
  readonly runtimeDirectory: string;
}): WorkReads {
  return {
    runPage: async (after) => {
      const reply = await send(settings.runtimeDirectory, {
        operation: "status",
        parameters: { after, limit: 500 },
      });
      if (reply.kind === "error") throw new Error(reply.error.code);
      return reply.result;
    },
    openTurn: () => turnOpen(settings.directory),
    pendingSubmission: () => pendingSubmission(settings.directory),
  };
}
