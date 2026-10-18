import assert from "node:assert/strict";
import filesystem, {
  mkdir,
  open,
  writeFile,
  rename,
  symlink,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { readTranscript, transcriptLimit } from "../src/chats/reader.ts";
import { inspectScanSource } from "../src/chats/source.ts";
import { withFiles } from "./quality/files-fixture.ts";

const source = JSON.stringify({
  type: "user",
  message: { role: "user", content: "valid prefix" },
});

for (const replacement of ["file", "directory", "link"] as const) {
  await test(`CLV-111 refuses ${replacement} identity changes before any source bytes`, async () => {
    await withFiles(
      { "root/project/source.jsonl": source, "outside/source.jsonl": source },
      async (directory) => {
        const path = join(directory, "root/project/source.jsonl");
        const inspection = await inspectScanSource(
          path,
          join(directory, "root"),
        );
        const original = filesystem.open;
        let reads = 0;
        filesystem.open = async (selectedPath, flags) => {
          if (replacement === "file") {
            await rename(path, `${path}.old`);
            await writeFile(path, source);
          } else {
            const project = join(directory, "root/project");
            await rename(project, `${project}.old`);
            if (replacement === "link")
              await symlink(join(directory, "outside"), project);
            else {
              await mkdir(project);
              await writeFile(path, source);
            }
          }
          const handle = await original(selectedPath, flags);
          Object.defineProperty(handle, "read", {
            configurable: true,
            value: () => {
              reads++;
              return Promise.reject(new Error("unexpected-source-read"));
            },
          });
          return handle;
        };
        syncBuiltinESMExports();
        try {
          const result = await readTranscript(path, { inspection });
          assert.equal(result.coverage.status, "unsupported");
          assert.equal(
            result.coverage.reason,
            replacement === "link" ? "symbolic-link" : "source-changed",
          );
          assert.deepEqual(result.records, []);
          assert.equal(reads, 0);
        } finally {
          filesystem.open = original;
          syncBuiltinESMExports();
        }
      },
    );
  });
}

await test("CLV-111 refuses canonical containment escapes before opening a source", async () => {
  await withFiles({ "root/source.jsonl": source }, async (directory) => {
    const path = join(directory, "root/source.jsonl");
    const inspection = await inspectScanSource(path, join(directory, "root"));
    const original = filesystem.realpath;
    Object.defineProperty(filesystem, "realpath", {
      configurable: true,
      value: () => Promise.resolve(join(directory, "root-escape/source.jsonl")),
    });
    syncBuiltinESMExports();
    try {
      const result = await readTranscript(path, { inspection });
      assert.equal(result.coverage.reason, "outside-root");
      assert.deepEqual(result.records, []);
    } finally {
      filesystem.realpath = original;
      syncBuiltinESMExports();
    }
  });
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
