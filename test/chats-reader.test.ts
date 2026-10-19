import { chatPlatformScenario } from "./chats-platform-fixture.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, open, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { readTranscript, transcriptLimit } from "../src/chats/reader.ts";
import { inspectScanSource } from "../src/chats/source.ts";
import { withFiles } from "./quality/files-fixture.ts";

const valid = JSON.stringify({
  type: "user",
  message: { role: "user", content: "selected" },
});

await test(
  "CLV-111 maps scanned oversized sources to unsupported while preserving positional status",
  chatPlatformScenario(async () => {
    await withFiles({ "root/project/source.jsonl": "" }, async (directory) => {
      const path = join(directory, "root/project/source.jsonl");
      await writeFile(path, Buffer.alloc(transcriptLimit + 1));
      const inspection = await inspectScanSource(path, join(directory, "root"));
      const result = await readTranscript(path, { inspection });
      assert.equal(result.coverage.status, "unsupported");
      assert.equal(result.coverage.reason, "file-too-large");
      assert.equal((await readTranscript(path)).coverage.status, "too-large");
    });
  }),
);

await test("CLV-095 reads exact bytes and retains stable IDs across repeated reads", async () => {
  await withFiles(
    { "source.jsonl": `${valid}\r\n${valid}` },
    async (directory) => {
      const path = join(directory, "source.jsonl");
      const first = await readTranscript(path);
      const digest = `sha256:${createHash("sha256").update(`${valid}\r\n${valid}`).digest("hex")}`;
      assert.equal(first.coverage.status, "included");
      assert.equal(first.coverage.digest, digest);
      assert.equal(first.coverage.recordCount, 2);
      assert.deepEqual(
        first.records.map((record) => record.sourceId),
        [`${digest}:0`, `${digest}:${String(Buffer.byteLength(valid) + 2)}`],
      );
      assert.deepEqual(await readTranscript(path), first);
      await writeFile(path, valid);
      const changed = await readTranscript(path);
      assert.notEqual(changed.coverage.digest, digest);
      assert.notEqual(changed.records[0]?.sourceId, first.records[0]?.sourceId);
    },
  );
});

await test("CLV-095 classifies refused sources and discards every refused prefix", async () => {
  await withFiles(
    {
      empty: "",
      bad: "{",
      shape: `${valid}\n${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "unknown" }] } })}`,
    },
    async (directory) => {
      await mkdir(join(directory, "folder"));
      await symlink(join(directory, "bad"), join(directory, "link"));
      assert.equal(spawnSync("mkfifo", [join(directory, "fifo")]).status, 0);
      await writeFile(join(directory, "utf8"), Buffer.from([0xc3, 0x28]));
      for (const [name, status, reason] of [
        ["empty", "unsupported", "empty-file"],
        ["bad", "unsupported", "invalid-json"],
        ["shape", "unsupported", "unsupported-block"],
        ["folder", "unsupported", "nonregular-file"],
        ["link", "unsupported", "symbolic-link"],
        ["fifo", "unsupported", "nonregular-file"],
        ["missing", "unreadable", "source-unreadable"],
        ["utf8", "unsupported", "invalid-utf8"],
      ] as const) {
        const result = await readTranscript(join(directory, name));
        assert.equal(result.coverage.status, status, name);
        assert.equal(result.coverage.reason, reason, name);
        assert.equal(result.coverage.recordCount, 0);
        assert.deepEqual(result.records, []);
      }
    },
  );
});

await test("CLV-095 permits exactly 10 MiB and refuses one extra byte", async () => {
  await withFiles({}, async (directory) => {
    const path = join(directory, "limit");
    await writeFile(
      path,
      valid + " ".repeat(transcriptLimit - Buffer.byteLength(valid)),
    );
    assert.equal((await readTranscript(path)).coverage.status, "included");
    await writeFile(path, " ", { flag: "a" });
    const result = await readTranscript(path);
    assert.equal(result.coverage.status, "too-large");
    assert.equal(result.coverage.reason, "file-too-large");
    assert.equal(result.coverage.digest, null);
  });
});

await test("CLV-095 reports open failures without transcript text or error details", async () => {
  await withFiles({ source: valid }, async (directory) => {
    const path = join(directory, "source");
    await chmod(path, 0);
    try {
      const result = await readTranscript(path);
      assert.equal(result.coverage.status, "unreadable");
      assert.equal(result.coverage.reason, "source-unreadable");
    } finally {
      await chmod(path, 0o600);
    }
  });
});

await test("CLV-095 bounds reads when an open source grows", async () => {
  await withFiles({ source: valid }, async (directory) => {
    const path = join(directory, "source");
    const handle = await open(path, "r");
    const prototype: unknown = Object.getPrototypeOf(handle);
    assert.ok(
      prototype &&
        typeof prototype === "object" &&
        "read" in prototype &&
        typeof prototype.read === "function",
    );
    let requested = 0;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "read");
    assert.ok(descriptor);
    Object.defineProperty(prototype, "read", {
      value: (buffer: Buffer) => {
        requested += buffer.length;
        buffer.fill(32);
        return Promise.resolve({ bytesRead: buffer.length, buffer });
      },
      configurable: true,
    });
    try {
      const result = await readTranscript(path);
      assert.equal(result.coverage.status, "too-large");
      assert.equal(result.coverage.reason, "file-too-large");
      assert.ok(requested <= transcriptLimit + 1);
    } finally {
      Object.defineProperty(prototype, "read", descriptor);
      await handle.close();
    }
  });
});

await test("CLV-113 records hashed byte lengths and exact prefix digests for UTF-8 and CRLF", async () => {
  const first = valid.replace("selected", "é synthetic") + "\r\n";
  const full = first + valid;
  await withFiles({ source: full }, async (directory) => {
    const result = await readTranscript(join(directory, "source"), {
      prefixBytes: Buffer.byteLength(first),
    });
    assert.equal(result.coverage.byteSize, Buffer.byteLength(full));
    assert.equal(
      result.prefixDigest,
      `sha256:${createHash("sha256").update(first).digest("hex")}`,
    );
    assert.equal(
      result.coverage.digest,
      `sha256:${createHash("sha256").update(full).digest("hex")}`,
    );
    assert.equal(
      (await readTranscript(join(directory, "source"))).prefixDigest,
      undefined,
    );
    assert.notEqual(Buffer.byteLength(first), first.length);
  });
});
