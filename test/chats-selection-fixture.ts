import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCorpus, validateCoverage } from "../src/chats/corpus-input.ts";
import { structureImport } from "../src/chats/structure.ts";
import type { CliResult } from "./cli-fixture.ts";

export const syntheticMessage = (content: string) =>
  JSON.stringify({ type: "user", message: { role: "user", content } });

export const rootScenarioFiles = {
  "A/project-keep/session-a.jsonl": syntheticMessage("A"),
  "A/project-skip/sentinel.jsonl": syntheticMessage("sentinel"),
  "B/project-keep/session-b.jsonl": syntheticMessage("B"),
  outside: syntheticMessage("outside"),
};

export async function readRootOutput(directory: string, importId: string) {
  const output = join(directory, "runtime/chats", importId);
  const coverage = await readFile(join(output, "coverage.json"), "utf8");
  validateCoverage(coverage, importId);
  const manifest: unknown = JSON.parse(coverage);
  assert.ok(
    manifest &&
      typeof manifest === "object" &&
      "schemaVersion" in manifest &&
      "entries" in manifest &&
      Array.isArray(manifest.entries),
  );
  assert.equal(manifest.schemaVersion, 2);
  const rows = manifest.entries.map((entry: unknown) => {
    assert.ok(
      entry &&
        typeof entry === "object" &&
        "path" in entry &&
        "status" in entry &&
        "reason" in entry &&
        "kind" in entry,
    );
    assert.equal(typeof entry.path, "string");
    return [
      String(entry.path).slice(directory.length + 1),
      entry.status,
      entry.reason,
      entry.kind,
    ];
  });
  const corpus = await readFile(join(output, "corpus.jsonl"), "utf8");
  return { output, coverage, corpus, rows, records: parseCorpus(corpus) };
}

export async function assertRootScenario(directory: string, result: CliResult) {
  assert.equal(result.status, 1, result.stderr);
  const summary: unknown = JSON.parse(result.stdout);
  assert.ok(
    summary &&
      typeof summary === "object" &&
      "importId" in summary &&
      typeof summary.importId === "string",
  );
  const output = await readRootOutput(directory, summary.importId);
  assert.deepEqual(
    output.records.map((record) => record.text),
    ["A", "B"],
  );
  assert.deepEqual(summary, {
    code: "import-partial",
    importId: summary.importId,
    included: 2,
    refused: 1,
    excluded: 1,
    pending: 0,
    ...structureImport(output.records).counts,
  });
  assert.deepEqual(output.rows, [
    ["A/project-keep/session-a.jsonl", "included", "supported", "file"],
    ["A/project-skip", "excluded", "project-excluded", "subtree"],
    ["B/project-keep/session-b.jsonl", "included", "supported", "file"],
    ["B/project-keep/session-z.jsonl", "unsupported", "symbolic-link", "file"],
  ]);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /project-|sentinel|outside|session-/,
  );
}
