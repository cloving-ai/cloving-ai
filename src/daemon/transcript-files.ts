import { open, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { located } from "./operation-journal.ts";
import type {
  TranscriptAttempt,
  TranscriptFiles,
  TranscriptPrompt,
} from "../turn-transcript.ts";

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

function promptOf(line: string): TranscriptPrompt[] {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null) return [];
    const attempt: unknown = Reflect.get(value, "attempt");
    const prompt: unknown = Reflect.get(value, "prompt");
    if (typeof prompt !== "string") return [];
    if (!Number.isSafeInteger(attempt) || Number(attempt) < 1) return [];
    return [{ attempt: Number(attempt), prompt }];
  } catch {
    return [];
  }
}

async function promptsOf(folder: string): Promise<TranscriptPrompt[]> {
  const text = await readFile(join(folder, "turn-prompts.jsonl"), "utf8").catch(
    (error: unknown) => {
      if (absent(error)) return "";
      throw error;
    },
  );
  return text.split("\n").slice(0, -1).flatMap(promptOf);
}

async function streamFrom(
  file: string,
  from: number,
): Promise<Pick<TranscriptFiles, "text" | "size">> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(Math.max(0, size - from));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
    return { text: buffer.subarray(0, bytesRead).toString("utf8"), size };
  } finally {
    await handle.close();
  }
}

export function transcriptFiles(
  directory: string,
): (operationId: string, from: number) => Promise<TranscriptFiles | undefined> {
  return async (operationId, from) => {
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
    const stream = names.includes("turn.jsonl")
      ? await streamFrom(join(folder, "turn.jsonl"), from)
      : { text: "", size: 0 };
    return {
      ...stream,
      attempts: merged(records.flatMap(attemptOf)),
      prompts: await promptsOf(folder),
    };
  };
}
