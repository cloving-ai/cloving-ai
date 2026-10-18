import assert from "node:assert/strict";
import filesystem, {
  readFile,
  readdir,
  type FileHandle,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
import { test } from "node:test";
import { redactImport } from "../src/chats/redact-import.ts";
import {
  base,
  corpus,
  coverage,
  files,
  importId,
} from "./chats-redact-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";

const cases = [
  ["coverage.json", "read"],
  ["coverage.json", "close"],
  ["corpus.jsonl", "read"],
  ["corpus.jsonl", "close"],
  ["redacted.jsonl", "write"],
  ["redacted.jsonl", "close"],
  ["redaction.json", "write"],
  ["redaction.json", "close"],
] as const;

function injectFailure(
  handle: FileHandle,
  operation: "read" | "write" | "close",
): void {
  if (operation === "write") {
    const write = handle.writeFile.bind(handle);
    handle.writeFile = async () => {
      await write('{"schemaVersion":1,');
      throw new Error("private-error-sentinel");
    };
  } else if (operation === "read") {
    handle.readFile = () => Promise.reject(new Error("private-error-sentinel"));
  } else {
    const close = handle.close.bind(handle);
    handle.close = async () => {
      await close();
      throw new Error("private-error-sentinel");
    };
  }
}

for (const [name, operation] of cases) {
  await test(`CLV-103 ${name} ${operation} failure leaves no success manifest or raw error`, async () => {
    await withFiles(files, async (directory) => {
      const original = filesystem.open;
      const handles: FileHandle[] = [];
      let injected = false;
      filesystem.open = async (path, flags) => {
        const handle = await original(path, flags, 0o600);
        handles.push(handle);
        if (basename(String(path)) === name) {
          injected = true;
          injectFailure(handle, operation);
        }
        return handle;
      };
      syncBuiltinESMExports();
      try {
        const result = await redactImport({
          importId,
          workingDirectory: directory,
          runtimeDirectory: "runtime",
          settings: { home: "/synthetic/home/operator", privateTexts: [] },
        });
        assert.equal(result.code, "redaction-failed");
        assert.equal(injected, true);
        assert.ok(handles.every((handle) => handle.fd === -1));
        assert.doesNotMatch(
          JSON.stringify(result),
          /private-error-sentinel|synthetic|Error|\//,
        );
        assert.ok(
          !(await readdir(join(directory, base))).includes("redaction.json"),
        );
        assert.equal(
          await readFile(join(directory, base, "corpus.jsonl"), "utf8"),
          corpus,
        );
        assert.equal(
          await readFile(join(directory, base, "coverage.json"), "utf8"),
          coverage,
        );
      } finally {
        filesystem.open = original;
        syncBuiltinESMExports();
      }
    });
  });
}

await test("CLV-103 opens the manifest only after the redacted corpus closes", async () => {
  await withFiles(files, async (directory) => {
    const original = filesystem.open;
    let corpusHandle: FileHandle | undefined;
    const observations: boolean[] = [];
    filesystem.open = async (path, flags) => {
      if (basename(String(path)) === "redaction.json")
        observations.push(corpusHandle?.fd === -1);
      const handle = await original(path, flags, 0o600);
      if (basename(String(path)) === "redacted.jsonl") corpusHandle = handle;
      return handle;
    };
    syncBuiltinESMExports();
    try {
      const result = await redactImport({
        importId,
        workingDirectory: directory,
        runtimeDirectory: "runtime",
        settings: { home: null, privateTexts: [] },
      });
      assert.equal(result.code, "redaction-complete");
      assert.deepEqual(observations, [true]);
    } finally {
      filesystem.open = original;
      syncBuiltinESMExports();
    }
  });
});

function injectChangedStat(
  handle: FileHandle,
  field: "type" | "links" | "device" | "inode",
): void {
  const stat = handle.stat.bind(handle);
  Object.defineProperty(handle, "stat", {
    value: async () => {
      const stats = await stat();
      if (field === "type") stats.isFile = () => false;
      if (field === "links") stats.nlink = 2;
      if (field === "device") stats.dev++;
      if (field === "inode") stats.ino++;
      return stats;
    },
  });
}

for (const field of ["type", "links", "device", "inode"] as const) {
  await test(`CLV-103 refuses changed input ${field} after opening it`, async () => {
    await withFiles(files, async (directory) => {
      const original = filesystem.open;
      const handles: FileHandle[] = [];
      let injected = false;
      filesystem.open = async (path, flags) => {
        const handle = await original(path, flags, 0o600);
        handles.push(handle);
        if (basename(String(path)) === "coverage.json") {
          injected = true;
          injectChangedStat(handle, field);
        }
        return handle;
      };
      syncBuiltinESMExports();
      try {
        const result = await redactImport({
          importId,
          workingDirectory: directory,
          runtimeDirectory: "runtime",
          settings: { home: null, privateTexts: [] },
        });
        assert.equal(result.code, "redaction-failed");
        assert.ok(injected);
        assert.ok(handles.every((handle) => handle.fd === -1));
        assert.deepEqual((await readdir(join(directory, base))).sort(), [
          "corpus.jsonl",
          "coverage.json",
        ]);
      } finally {
        filesystem.open = original;
        syncBuiltinESMExports();
      }
    });
  });
}

await test("CLV-103 refuses unavailable output metadata without exposing the error", async () => {
  await withFiles(files, async (directory) => {
    const original = filesystem.lstat;
    Object.defineProperty(filesystem, "lstat", {
      configurable: true,
      value: (
        path: Parameters<typeof filesystem.lstat>[0],
        options: Parameters<typeof filesystem.lstat>[1],
      ) => {
        return basename(String(path)) === "redacted.jsonl"
          ? Promise.reject(
              Object.assign(new Error("private-error-sentinel"), {
                code: "EACCES",
              }),
            )
          : original(path, options);
      },
    });
    syncBuiltinESMExports();
    try {
      const result = await redactImport({
        importId,
        workingDirectory: directory,
        runtimeDirectory: "runtime",
        settings: { home: null, privateTexts: [] },
      });
      assert.equal(result.code, "redaction-failed");
      assert.doesNotMatch(
        JSON.stringify(result),
        /private-error-sentinel|EACCES/,
      );
      assert.deepEqual((await readdir(join(directory, base))).sort(), [
        "corpus.jsonl",
        "coverage.json",
      ]);
    } finally {
      filesystem.lstat = original;
      syncBuiltinESMExports();
    }
  });
});

await test("CLV-103 the file adapter also refuses an invalid import ID", async () => {
  await withFiles(files, async (directory) => {
    const result = await redactImport({
      importId: "invalid",
      workingDirectory: directory,
      runtimeDirectory: "runtime",
      settings: { home: null, privateTexts: [] },
    });
    assert.equal(result.code, "redaction-failed");
    assert.deepEqual((await readdir(join(directory, base))).sort(), [
      "corpus.jsonl",
      "coverage.json",
    ]);
  });
});
