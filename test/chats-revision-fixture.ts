import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { importChats } from "../src/chats/import.ts";

export const source =
  JSON.stringify({
    type: "user",
    message: { role: "user", content: "synthetic é revision" },
  }) + "\r\n";
export const importId = "01234567-89ab-4cde-8fab-0123456789ab";
export const otherId = "01234567-89ab-4cde-8fab-0123456789ac";
export const digest = `sha256:${"a".repeat(64)}`;
export const entry = {
  path: "/synthetic/A",
  status: "included",
  reason: "supported",
  digest,
  byteSize: 10,
  recordCount: 1,
  omissions: { metadataRecords: 0, thinkingBlocks: 0 },
};
export const coverage = { schemaVersion: 1, importId, files: [entry] };
export const revision = {
  schemaVersion: 1,
  importId,
  previousImportId: otherId,
  evidenceRevision: 1,
  counts: {
    new: 1,
    missing: 0,
    unchanged: 0,
    changed: 0,
    truncated: 0,
    extended: 0,
  },
  entries: [
    {
      path: entry.path,
      root: null,
      before: null,
      after: { digest, byteSize: 10 },
      status: "new",
      reason: "no-previous-entry",
    },
  ],
};

export function request(directory: string) {
  return {
    paths: ["source"],
    workingDirectory: directory,
    runtimeDirectory: "runtime",
  };
}

export async function readJson(path: string): Promise<Record<string, unknown>> {
  return parseObject(await readFile(path, "utf8"));
}

export function parseObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

export async function initialImport(directory: string) {
  const result = await importChats(request(directory));
  assert.ok(result.importId);
  return {
    importId: result.importId,
    output: join(directory, "runtime/chats", result.importId),
  };
}

export function assertScenarioRevision(
  directory: string,
  value: Record<string, unknown>,
) {
  const entries = value["entries"];
  assert.ok(Array.isArray(entries));
  assert.deepEqual(
    entries.map((entry: { path: string; status: string; reason: string }) => [
      entry.path,
      entry.status,
      entry.reason,
    ]),
    [
      [join(directory, "A"), "extended", "verified-prefix"],
      [join(directory, "B"), "truncated", "shorter-source"],
      [join(directory, "D"), "new", "no-previous-entry"],
      [join(directory, "C"), "missing", "not-selected"],
    ],
  );
  assert.equal(value["evidenceRevision"], 1);
  assert.deepEqual(value["counts"], {
    new: 1,
    missing: 1,
    unchanged: 0,
    changed: 0,
    truncated: 1,
    extended: 1,
  });
}
