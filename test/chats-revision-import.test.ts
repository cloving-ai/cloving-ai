import { chatPlatformScenario } from "./chats-platform-fixture.ts";
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { importChats } from "../src/chats/import.ts";
import { withFiles } from "./quality/files-fixture.ts";
import {
  initialImport,
  readJson,
  request,
  source,
} from "./chats-revision-fixture.ts";

async function revised(
  directory: string,
  data: {
    readonly previousImportId: string;
    readonly paths: readonly string[];
    readonly roots?: readonly string[];
  },
) {
  const result = await importChats({ ...request(directory), ...data });
  assert.ok(result.importId);
  const output = await readJson(
    join(directory, "runtime/chats", result.importId, "revision.json"),
  );
  const entries = output["entries"];
  assert.ok(Array.isArray(entries));
  return { result, output, entries };
}

await test(
  "CLV-113 legacy changed sources cannot prove extension or truncation without size",
  chatPlatformScenario(async () => {
    await withFiles({ source, other: source }, async (directory) => {
      const first = await initialImport(directory);
      const path = join(first.output, "coverage.json");
      const coverage = await readJson(path);
      const files = coverage["files"];
      assert.ok(Array.isArray(files));
      coverage["files"] = files.map((value: Record<string, unknown>) =>
        Object.fromEntries(
          Object.entries(value).filter(([key]) => key !== "byteSize"),
        ),
      );
      await writeFile(path, JSON.stringify(coverage));
      for (const text of [source + source, source.trim()]) {
        await writeFile(join(directory, "source"), text);
        const result = await revised(directory, {
          previousImportId: first.importId,
          paths: ["source"],
        });
        assert.deepEqual(
          result.entries.map((value: { status: string; reason: string }) => [
            value.status,
            value.reason,
          ]),
          [["changed", "previous-size-unknown"]],
        );
      }
      await writeFile(join(directory, "source"), source);
      const equal = await revised(directory, {
        previousImportId: first.importId,
        paths: ["source", "other"],
      });
      assert.deepEqual(
        equal.entries.map((value: { status: string }) => value.status),
        ["unchanged", "new"],
      );
      await rm(join(directory, "source"));
      const absent = await revised(directory, {
        previousImportId: first.importId,
        paths: ["source"],
      });
      assert.equal(absent.result.code, "import-partial");
      assert.deepEqual(
        absent.entries.map((value: { reason: string }) => value.reason),
        ["not-included"],
      );
    });
  }),
);

await test(
  "CLV-113 resolves changed root indexes and separates positional selections and repeated keys",
  chatPlatformScenario(async () => {
    await withFiles(
      { "B/source.jsonl": source, "A/other.jsonl": source },
      async (directory) => {
        const first = await importChats({
          ...request(directory),
          paths: ["B/source.jsonl", "B/source.jsonl"],
          roots: ["B"],
        });
        assert.ok(first.importId);
        const next = await revised(directory, {
          previousImportId: first.importId,
          paths: ["B/source.jsonl"],
          roots: ["B", "A"],
        });
        assert.deepEqual(
          next.entries.map((value: { root: string | null; status: string }) => [
            value.root,
            value.status,
          ]),
          [
            [null, "unchanged"],
            [join(directory, "A"), "new"],
            [join(directory, "B"), "unchanged"],
            [null, "missing"],
          ],
        );
        assert.equal(next.result.code, "import-partial");
      },
    );
  }),
);

await test(
  "CLV-113 larger sources with changed prefixes stay changed and preserve byte evidence",
  chatPlatformScenario(async () => {
    await withFiles({ source }, async (directory) => {
      const first = await initialImport(directory);
      const changed = source.replace("é", "x") + source;
      await writeFile(join(directory, "source"), changed);
      const next = await revised(directory, {
        previousImportId: first.importId,
        paths: ["source"],
      });
      assert.equal(next.result.code, "import-complete");
      assert.deepEqual(
        next.entries.map(
          (value: {
            status: string;
            reason: string;
            before: { byteSize: number };
            after: { byteSize: number };
          }) => [
            value.status,
            value.reason,
            value.before.byteSize,
            value.after.byteSize,
          ],
        ),
        [
          [
            "changed",
            "digest-changed",
            Buffer.byteLength(source),
            Buffer.byteLength(changed),
          ],
        ],
      );
      assert.equal(await readFile(join(directory, "source"), "utf8"), changed);
    });
  }),
);

await test(
  "CLV-113 revision comparisons preserve known copies and unknown completeness",
  chatPlatformScenario(async () => {
    const identified = JSON.stringify({
      type: "user",
      uuid: "synthetic-id",
      sessionId: "synthetic-session",
      parentUuid: null,
      message: { role: "user", content: "synthetic copy" },
    });
    await withFiles({ source: identified }, async (directory) => {
      const first = await initialImport(directory);
      const next = await revised(directory, {
        previousImportId: first.importId,
        paths: ["source", "source"],
      });
      assert.equal(next.result.records, 2);
      assert.equal(next.result.copies, 1);
      assert.ok(next.result.importId);
      const structure = await readJson(
        join(
          directory,
          "runtime/chats",
          next.result.importId,
          "structure.json",
        ),
      );
      assert.equal(structure["historyCompleteness"], "unknown");
      assert.deepEqual(
        next.entries.map((value: { status: string }) => value.status),
        ["unchanged", "new"],
      );
    });
  }),
);
