import assert from "node:assert/strict";
import filesystem, { mkdir, open, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { readTranscript, transcriptLimit } from "../src/chats/reader.ts";
import { withFiles } from "./quality/files-fixture.ts";

const source = JSON.stringify({
  type: "user",
  message: { role: "user", content: "valid prefix" },
});

await test("CLV-095 reports a source replaced by a link before open as unsupported", async () => {
  await withFiles({ source }, async (directory) => {
    const original = filesystem.open;
    filesystem.open = () =>
      Promise.reject(
        Object.assign(new Error("private-path"), { code: "ELOOP" }),
      );
    syncBuiltinESMExports();
    try {
      const result = await readTranscript(join(directory, "source"));
      assert.equal(result.coverage.status, "unsupported");
      assert.equal(result.coverage.reason, "symbolic-link");
      assert.deepEqual(result.records, []);
    } finally {
      filesystem.open = original;
      syncBuiltinESMExports();
    }
  });
});

for (const [target, status, reason] of [
  ["folder", "unsupported", "nonregular-file"],
  ["large", "too-large", "file-too-large"],
] as const) {
  await test(`CLV-095 checks ${reason} on the open handle`, async () => {
    await withFiles({ source }, async (directory) => {
      await mkdir(join(directory, "folder"));
      await writeFile(
        join(directory, "large"),
        Buffer.alloc(transcriptLimit + 1),
      );
      const handle = await open(join(directory, target), "r");
      const original = filesystem.open;
      filesystem.open = () => Promise.resolve(handle);
      syncBuiltinESMExports();
      try {
        const result = await readTranscript(join(directory, "source"));
        assert.equal(result.coverage.status, status);
        assert.equal(result.coverage.reason, reason);
        assert.deepEqual(result.records, []);
        assert.equal(handle.fd, -1);
      } finally {
        filesystem.open = original;
        syncBuiltinESMExports();
        await handle.close();
      }
    });
  });
}

await test("CLV-095 a read failure discards bytes and closes the source handle", async () => {
  await withFiles({ source }, async (directory) => {
    const handle = await open(join(directory, "source"), "r");
    const original = filesystem.open;
    filesystem.open = () => Promise.resolve(handle);
    const descriptor = Object.getOwnPropertyDescriptor(handle, "read");
    let reads = 0;
    Object.defineProperty(handle, "read", {
      configurable: true,
      value: () => {
        reads++;
        return Promise.reject(new Error("private read failure"));
      },
    });
    syncBuiltinESMExports();
    try {
      const result = await readTranscript(join(directory, "source"));
      assert.equal(reads, 1);
      assert.equal(result.coverage.status, "unreadable");
      assert.equal(result.coverage.reason, "source-unreadable");
      assert.equal(result.coverage.digest, null);
      assert.deepEqual(result.records, []);
      assert.equal(handle.fd, -1);
    } finally {
      filesystem.open = original;
      syncBuiltinESMExports();
      Reflect.deleteProperty(handle, "read");
      if (descriptor) Object.defineProperty(handle, "read", descriptor);
      await handle.close();
    }
  });
});
