import { open, readFile, rename } from "node:fs/promises";
import { record } from "../protocol.ts";

export interface SentEntry {
  readonly key: string;
  readonly runId: string;
}

function entryOf(value: unknown): SentEntry {
  const entry = record(value);
  const key = entry?.["key"];
  const runId = entry?.["runId"];
  if (typeof key !== "string" || typeof runId !== "string")
    throw new Error("invalid-channel-record");
  return { key, runId };
}

function parsed(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    throw new Error("invalid-channel-record");
  }
}

export async function sentEntries(
  file: string,
): Promise<Map<string, SentEntry>> {
  const text = await readFile(file, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  });
  if (text === undefined) return new Map();
  const journal = record(parsed(text));
  const entries = journal?.["entries"];
  if (journal?.["version"] !== 1 || !Array.isArray(entries))
    throw new Error("invalid-channel-record");
  return new Map(
    entries.map((value: unknown) => {
      const entry = entryOf(value);
      return [entry.key, entry];
    }),
  );
}

async function saved(
  file: string,
  entries: Iterable<SentEntry>,
): Promise<void> {
  const temporary = `${file}.${String(process.pid)}.tmp`;
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(
      `${JSON.stringify({ version: 1, entries: [...entries] })}\n`,
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}

export async function recordSent(
  file: string,
  entry: SentEntry,
): Promise<void> {
  const entries = await sentEntries(file);
  entries.set(entry.key, entry);
  await saved(file, entries.values());
}

export async function prunedSent(
  file: string,
  kept: (entry: SentEntry) => boolean,
): Promise<void> {
  const entries = [...(await sentEntries(file)).values()];
  const remaining = entries.filter(kept);
  if (remaining.length < entries.length) await saved(file, remaining);
}
