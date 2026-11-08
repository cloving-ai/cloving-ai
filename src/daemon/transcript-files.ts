import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { located } from "./operation-journal.ts";
import type { TranscriptAttempt, TranscriptFiles } from "../turn-transcript.ts";

const attemptName = /^attempt-\d+\.json$/;

function absent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function stored(folder: string, name: string): Promise<unknown> {
  try {
    const value: unknown = JSON.parse(
      await readFile(join(folder, name), "utf8"),
    );
    return value;
  } catch {
    return undefined;
  }
}

function attemptOf(value: unknown): TranscriptAttempt[] {
  if (typeof value !== "object" || value === null) return [];
  const attempt: unknown = Reflect.get(value, "attempt");
  if (typeof attempt !== "number") return [];
  const resumed = Reflect.get(value, "resumedAfter") === "daemon-restart";
  return [{ attempt, resumed }];
}

function merged(found: readonly TranscriptAttempt[]): TranscriptAttempt[] {
  const numbers = [...new Set(found.map((item) => item.attempt))];
  return numbers
    .toSorted((first, second) => first - second)
    .map((attempt) => ({
      attempt,
      resumed: found.some((item) => item.attempt === attempt && item.resumed),
    }));
}

export function transcriptFiles(
  directory: string,
): (operationId: string) => Promise<TranscriptFiles | undefined> {
  return async (operationId) => {
    const { folder } = located(join(directory, "journal"), operationId);
    const names = await readdir(folder).catch((error: unknown) => {
      if (absent(error)) return undefined;
      throw error;
    });
    if (names === undefined) return undefined;
    const records = await Promise.all(
      [...names.filter((name) => attemptName.test(name)), "started.json"].map(
        (name) => stored(folder, name),
      ),
    );
    const text = names.includes("turn.jsonl")
      ? await readFile(join(folder, "turn.jsonl"), "utf8")
      : "";
    return { text, attempts: merged(records.flatMap(attemptOf)) };
  };
}
