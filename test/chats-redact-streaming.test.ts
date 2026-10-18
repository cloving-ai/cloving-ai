import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import filesystem, {
  appendFile,
  open,
  readFile,
  readdir,
  type FileHandle,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename, join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { redactImport } from "../src/chats/redact-import.ts";
import { base, files, importId, record } from "./chats-redact-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";

interface Observations {
  writes: unknown[];
  reads: number[];
  chunkSize: number;
}

function observeCorpus(handle: FileHandle, observations: Observations): void {
  const read = handle.read.bind(handle);
  Object.defineProperty(handle, "read", {
    value: async (options: { buffer: Buffer }) => {
      observations.reads.push(observations.writes.length);
      return read({
        buffer: options.buffer,
        length: Math.min(options.buffer.length, observations.chunkSize),
      });
    },
  });
}

function observeFiles(chunkSize: number) {
  const original = filesystem.open;
  const observations: Observations = { writes: [], reads: [], chunkSize };
  filesystem.open = async (path, flags) => {
    const handle = await original(path, flags, 0o600);
    if (basename(String(path)) === "corpus.jsonl")
      observeCorpus(handle, observations);
    if (basename(String(path)) === "redacted.jsonl") {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (data, options) => {
        observations.writes.push(data);
        return write(data, options);
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
  return {
    observations,
    restore() {
      filesystem.open = original;
      syncBuiltinESMExports();
    },
  };
}

async function createCollection(directory: string) {
  const input = await open(join(directory, base, "corpus.jsonl"), "w");
  const expected = createHash("sha256");
  const padding = "benign ".repeat(16_384);
  const count = 1_024;
  try {
    for (let index = 0; index < count; index++) {
      const row = {
        ...record,
        sourceId: `synthetic:${String(index)}`,
        text: `${padding}person@example.test`,
        blocks: [],
      };
      await input.writeFile(JSON.stringify(row) + "\n");
      expected.update(
        JSON.stringify({ ...row, text: `${padding}[EMAIL]` }) + "\n",
      );
    }
  } finally {
    await input.close();
  }
  return { digest: expected.digest("hex"), count };
}

await test("CLV-103 redacts a collection larger than the process heap", async () => {
  await withFiles(files, async (directory) => {
    const { digest, count } = await createCollection(directory);
    const entry = pathToFileURL(resolve("src/chats/redact-import.ts")).href;
    const request = {
      importId,
      workingDirectory: directory,
      runtimeDirectory: "runtime",
      settings: { home: null, privateTexts: [] },
    };
    const result = spawnSync(
      process.execPath,
      [
        "--max-old-space-size=64",
        "--input-type=module",
        "-e",
        `import { redactImport } from ${JSON.stringify(entry)}; console.log(JSON.stringify(await redactImport(${JSON.stringify(request)})));`,
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      code: "redaction-complete",
      importId,
      recordCount: count,
      counts: {
        privateKey: 0,
        credentialUrl: 0,
        homePath: 0,
        token: 0,
        email: count,
        privateText: 0,
      },
      totalCount: count,
    });
    const actual = createHash("sha256");
    for await (const chunk of createReadStream(
      join(directory, base, "redacted.jsonl"),
    )) {
      assert.ok(Buffer.isBuffer(chunk));
      actual.update(chunk);
    }
    assert.equal(actual.digest("hex"), digest);
  });
});

for (const suffix of [
  Buffer.from("\n"),
  Buffer.from("{invalid}"),
  Buffer.from(JSON.stringify({ ...record, schemaVersion: 2 })),
  Buffer.from([0xc3]),
]) {
  await test("CLV-103 late invalid input leaves no outputs or changed originals", async () => {
    const prefix =
      JSON.stringify({
        ...record,
        text: "benign ".repeat(16_384),
        blocks: [],
      }) + "\n";
    await withFiles(
      { ...files, [`${base}/corpus.jsonl`]: prefix },
      async (directory) => {
        const path = join(directory, base, "corpus.jsonl");
        await appendFile(path, suffix);
        const original = await readFile(path);
        const result = await redactImport({
          importId,
          workingDirectory: directory,
          runtimeDirectory: "runtime",
          settings: { home: null, privateTexts: [] },
        });
        assert.equal(result.code, "redaction-failed");
        assert.deepEqual((await readdir(join(directory, base))).sort(), [
          "corpus.jsonl",
          "coverage.json",
        ]);
        assert.deepEqual(await readFile(path), original);
      },
    );
  });
}

for (const chunkSize of [17, 65_536]) {
  await test(`CLV-103 streams records through ${String(chunkSize)} byte reads`, async () => {
    const line = JSON.stringify({
      ...record,
      text: "é ~/x ".repeat(300),
      blocks: [],
    }).replace(
      '"blocks":[]',
      '"blocks":[{"type":"tool_use","position":0,"id":"call","name":"tool","input":1e400}]',
    );
    const count = 40;
    const expected = line.replaceAll("~/x", "[HOME_PATH]");
    const corpus = (line + "\n").repeat(count - 1) + line;
    await withFiles(
      { ...files, [`${base}/corpus.jsonl`]: corpus },
      async (directory) => {
        const observer = observeFiles(chunkSize);
        const { observations } = observer;
        try {
          const result = await redactImport({
            importId,
            workingDirectory: directory,
            runtimeDirectory: "runtime",
            settings: { home: null, privateTexts: [] },
          });
          assert.equal(result.code, "redaction-complete");
          assert.equal(observations.writes.length, count);
          assert.ok(
            observations.reads.some((writes) => writes > 0 && writes < count),
          );
          assert.ok(
            observations.writes.every((text) => text === expected + "\n"),
          );
          assert.equal(result.recordCount, count);
          assert.equal(result.counts.homePath, 300 * count);
          assert.equal(result.totalCount, 300 * count);
          assert.equal(
            await readFile(join(directory, base, "redacted.jsonl"), "utf8"),
            (expected + "\n").repeat(count),
          );
          assert.equal(
            await readFile(join(directory, base, "corpus.jsonl"), "utf8"),
            corpus,
          );
        } finally {
          observer.restore();
        }
      },
    );
  });
}
