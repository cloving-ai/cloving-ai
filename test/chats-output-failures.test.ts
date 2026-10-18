import assert from "node:assert/strict";
import filesystem, { readdir, type FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
import { test } from "node:test";
import { importChats } from "../src/chats/import.ts";
import { withFiles } from "./quality/files-fixture.ts";

const source = JSON.stringify({
  type: "user",
  message: { role: "user", content: "private-output-sentinel" },
});

for (const [name, operation] of [
  ["corpus.jsonl", "close"],
  ["structure.json", "create"],
  ["structure.json", "write"],
  ["structure.json", "close"],
  ["coverage.json", "write"],
  ["coverage.json", "close"],
] as const) {
  await test(`CLV-095 ${name} ${operation} failure leaves no completed manifest`, async () => {
    await withFiles({ source }, async (directory) => {
      const original = filesystem.open;
      const handles: FileHandle[] = [];
      let injected = false;
      filesystem.open = async (path, flags) => {
        if (basename(String(path)) === name && operation === "create") {
          injected = true;
          throw new Error("private-create-error");
        }
        const handle = await original(path, flags, 0o600);
        handles.push(handle);
        if (basename(String(path)) === name) {
          injected = true;
          if (operation === "write") {
            const write = handle.writeFile.bind(handle);
            handle.writeFile = async () => {
              await write('{"schemaVersion":1,');
              throw new Error("private-write-error");
            };
          } else {
            const close = handle.close.bind(handle);
            handle.close = async () => {
              await close();
              throw new Error("private-close-error");
            };
          }
        }
        return handle;
      };
      syncBuiltinESMExports();
      try {
        const result = await importChats({
          paths: ["source"],
          workingDirectory: directory,
          runtimeDirectory: "runtime",
        });
        assert.equal(result.code, "output-failed");
        assert.equal(result.importId, null);
        assert.equal(injected, true);
        assert.ok(handles.every((handle) => handle.fd === -1));
        const files = await readdir(join(directory, "runtime"), {
          recursive: true,
        });
        assert.ok(files.every((file) => !file.endsWith("coverage.json")));
      } finally {
        filesystem.open = original;
        syncBuiltinESMExports();
      }
    });
  });
}

await test("CLV-095 opens the final manifest only after the corpus closes", async () => {
  await withFiles({ source }, async (directory) => {
    const original = filesystem.open;
    let corpus: FileHandle | undefined;
    let structure: FileHandle | undefined;
    const closed: boolean[] = [];
    const corpusClosed: boolean[] = [];
    filesystem.open = async (path, flags) => {
      if (basename(String(path)) === "coverage.json")
        closed.push(corpus?.fd === -1 && structure?.fd === -1);
      const handle = await original(path, flags, 0o600);
      if (basename(String(path)) === "corpus.jsonl") corpus = handle;
      if (basename(String(path)) === "structure.json") {
        corpusClosed.push(corpus?.fd === -1);
        structure = handle;
      }
      return handle;
    };
    syncBuiltinESMExports();
    try {
      const result = await importChats({
        paths: ["source"],
        workingDirectory: directory,
        runtimeDirectory: "runtime",
      });
      assert.equal(result.code, "import-complete");
      assert.deepEqual(closed, [true]);
      assert.deepEqual(corpusClosed, [true]);
    } finally {
      filesystem.open = original;
      syncBuiltinESMExports();
    }
  });
});
