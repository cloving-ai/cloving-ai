import assert from "node:assert/strict";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { importChats } from "../src/chats/import.ts";
import { normalizeTranscript } from "../src/chats/normalize.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { chatPlatformScenario } from "./chats-platform-fixture.ts";
import { readRootOutput } from "./chats-selection-fixture.ts";

const corpusLimit = 52_428_800;

function largeTranscript(): string {
  const envelope = {
    type: "user",
    uuid: "synthetic-id0",
    sessionId: "synthetic-session",
    parentUuid: null,
    timestamp: null,
    message: { role: "user", content: "" },
  };
  const normalized = normalizeTranscript(
    JSON.stringify(envelope),
    `sha256:${"0".repeat(64)}`,
  );
  const overhead = Buffer.byteLength(
    `${JSON.stringify(normalized.records[0])}\n`,
  );
  const textBytes = (corpusLimit / 10 - overhead) / 2;
  envelope.message.content =
    "é".repeat(Math.floor(textBytes / 2)) + "a".repeat(textBytes % 2);
  return JSON.stringify(envelope);
}

for (const extraBytes of [0, 1]) {
  await test(
    `CLV-110 bounds repeated imports at the total UTF-8 corpus limit plus ${String(extraBytes)} bytes`,
    chatPlatformScenario(async () => {
      const selected = largeTranscript();
      const last =
        extraBytes === 0
          ? selected
          : selected.replace('"timestamp":null', '"timestamp":"utc"');
      await withFiles({ selected, last }, async (directory) => {
        const result = await importChats({
          paths: [...Array<string>(9).fill("selected"), "last"],
          workingDirectory: directory,
          runtimeDirectory: "runtime",
        });
        assert.equal(
          result.code,
          extraBytes === 0 ? "import-complete" : "output-failed",
        );
        const chats = join(directory, "runtime", "chats");
        const imports = await readdir(chats);
        assert.equal(imports.length, 1);
        const output = join(chats, String(imports[0]));
        assert.equal(
          (await stat(join(output, "corpus.jsonl"))).size,
          extraBytes === 0 ? corpusLimit : (corpusLimit / 10) * 9,
        );
        const files = await readdir(output);
        assert.equal(result.records, extraBytes === 0 ? 10 : 0);
        assert.equal(result.copies, extraBytes === 0 ? 9 : 0);
        assert.equal(
          result.importId,
          extraBytes === 0 ? String(imports[0]) : null,
        );
        assert.deepEqual(
          files,
          extraBytes === 0
            ? ["corpus.jsonl", "coverage.json", "structure.json"]
            : ["corpus.jsonl"],
        );
      });
    }),
  );
}

await test(
  "CLV-111 mixed imports share the normalized corpus limit and preserve oversized status forms",
  chatPlatformScenario(async () => {
    const selected = largeTranscript();
    await withFiles(
      { selected, "root/last.jsonl": selected },
      async (directory) => {
        const result = await importChats({
          paths: Array<string>(9).fill("selected"),
          roots: ["root"],
          workingDirectory: directory,
          runtimeDirectory: "runtime",
        });
        assert.equal(result.code, "import-complete");
        assert.equal(result.records, 10);
        assert.ok(result.importId);
        const output = await readRootOutput(directory, result.importId);
        assert.equal(Buffer.byteLength(output.corpus), corpusLimit);
        const failed = await importChats({
          paths: Array<string>(10).fill("selected"),
          roots: ["root"],
          workingDirectory: directory,
          runtimeDirectory: "runtime",
        });
        assert.equal(failed.code, "output-failed");
        assert.deepEqual(
          [
            failed.importId,
            failed.included,
            failed.refused,
            failed.excluded,
            failed.pending,
            failed.records,
          ],
          [null, 0, 0, 0, 0, 0],
        );
        await writeLarge(join(directory, "root/large.jsonl"));
        const large = await importChats({
          paths: ["root/large.jsonl"],
          roots: ["root"],
          workingDirectory: directory,
          runtimeDirectory: "runtime",
        });
        assert.ok(large.importId);
        const oversized = await readRootOutput(directory, large.importId);
        assert.deepEqual(
          oversized.rows
            .filter((row) => String(row[0]).endsWith("large.jsonl"))
            .map((row) => row.slice(1, 3)),
          [
            ["too-large", "file-too-large"],
            ["unsupported", "file-too-large"],
          ],
        );
      },
    );
  }),
);

async function writeLarge(path: string) {
  const handle = await open(path, "w");
  try {
    await handle.truncate(10_485_761);
  } finally {
    await handle.close();
  }
}
