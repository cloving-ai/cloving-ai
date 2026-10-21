import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { importId } from "./chats-worker-fixture.ts";
import assert from "node:assert/strict";
import { field } from "./develop-workflow-fixture.ts";
import { digestOf } from "./service-fixture.ts";
import { parseCorpus } from "../src/chats/corpus-input.ts";
import { snapshot } from "./analyze-chats-workflow-fixture.ts";
import { batch } from "./chats-analysis-merge-fixture.ts";
import { analysisSetup } from "./analyze-chats-sdk-fixture.ts";

export function batchCorpus(textSize = 2_000): string {
  return parseCorpus(snapshot.corpus)
    .map((message) =>
      JSON.stringify({ ...message, text: "🦊".repeat(textSize) }),
    )
    .join("\n");
}

export function batchSetup(
  options: {
    readonly corpus?: string;
    readonly reply?: unknown;
    readonly mode?: string;
  } = {},
): string {
  return `
writeFileSync("batch-reply.json", ${JSON.stringify(JSON.stringify(options.reply ?? batch()))});
${options.mode === undefined ? "" : `writeFileSync("batch-turn-mode", ${JSON.stringify(options.mode)});`}
${analysisSetup}
writeFileSync(directory + "/redacted.jsonl", ${JSON.stringify(options.corpus ?? batchCorpus())}, { mode: 0o600 });
`;
}

export const inspectBatchCheckpoints = `
const folder = directory + "/" + readdirSync(directory).find((name) => name.startsWith("capture-"));
const checkpoints = ["checkpoint-0.json", ...readdirSync(folder).filter((name) => name.startsWith("analysis-checkpoint-")).sort()].map((name) => JSON.parse(readFileSync(folder + "/" + name, "utf8")));
const proposals = ["proposal-0.txt", ...readdirSync(folder).filter((name) => name.startsWith("proposal-checkpoint-")).sort()].map((name) => readFileSync(folder + "/" + name, "utf8").split("\\n")[0]);
print({ checkpoints: checkpoints.map(({ status, covered, uncovered, completedBatchCount, total, result }) => ({ status, covered, uncovered, completedBatchCount, total, hasResult: result !== null })), proposals, conflicts: readdirSync(folder).filter((name) => name.startsWith("conflict-")) });
`;

export function assertBatchRestart(lines: readonly unknown[]): void {
  const details = lines[0];
  assert.equal(field(details, "recordsDigest"), digestOf(batchCorpus()));
  assert.equal(field(details, "saves"), 3);
  assert.equal(field(details, "previousResultsMatch"), true);
  const checkpoints = field(details, "checkpoints");
  assert.ok(Array.isArray(checkpoints));
  assert.equal(checkpoints.length, 3);
  let covered = 0;
  for (const [index, checkpoint] of checkpoints.entries()) {
    assert.equal(
      field(checkpoint, "status"),
      index === 2 ? "complete" : "partial",
    );
    assert.equal(field(checkpoint, "completedBatchCount"), index + 1);
    assert.ok(Number(field(checkpoint, "covered")) > covered);
    covered = Number(field(checkpoint, "covered"));
    assert.equal(covered + Number(field(checkpoint, "uncovered")), 16);
  }
  const contexts = field(details, "contexts");
  assert.ok(Array.isArray(contexts));
  assert.equal(contexts.length, 3);
  assert.equal(field(contexts[0], "previousResult"), null);
  for (const context of contexts.slice(1))
    assert.ok(field(context, "previousResult"));
  const final = lines[1];
  assert.equal(field(field(final, "outcome"), "kind"), "handoff_requested");
  assert.deepEqual(field(final, "budget"), { limit: 11, spent: 7 });
  assert.equal(field(final, "turns"), 3);
  assert.equal(field(final, "usageTurns"), 3);
  assert.equal(field(final, "cost"), 0.75);
  assert.equal(field(final, "safe"), true);
}

export async function firstCheckpointFiles(directory: string) {
  const imported = join(directory, "runtime", "chats", importId);
  const [capture] = (await readdir(imported)).filter((name) =>
    name.startsWith("capture-"),
  );
  assert.ok(capture);
  const files = [];
  for (const name of [
    "analysis-checkpoint-1.json",
    "proposal-checkpoint-1.txt",
  ]) {
    const path = join(imported, capture, name);
    files.push({
      name,
      inode: (await stat(path)).ino,
      bytes: await readFile(path, "utf8"),
    });
  }
  return files;
}
