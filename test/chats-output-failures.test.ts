import { initialImport } from "./chats-revision-fixture.ts";
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
const selectedSources = { source, "root/source.jsonl": source };

for (const mode of ["positional", "root", "revision"]) {
  for (const [name, operation] of [
    ["corpus.jsonl", "close"],
    ["structure.json", "create"],
    ["structure.json", "write"],
    ["structure.json", "close"],
    ...(mode === "revision"
      ? ([
          ["revision.json", "create"],
          ["revision.json", "write"],
          ["revision.json", "close"],
        ] as const)
      : []),
    ["coverage.json", "write"],
    ["coverage.json", "close"],
  ] as const) {
    await test(`CLV-095 ${mode} ${name} ${operation} failure leaves no completed manifest`, async () => {
      await withFiles(selectedSources, async (directory) => {
        const previous =
          mode === "revision" ? await initialImport(directory) : undefined;
        const observer = interceptFailure({
          name,
          operation,
          previousOutput: previous?.output,
        });
        try {
          const result = await importChats({
            ...(previous === undefined
              ? {}
              : { previousImportId: previous.importId }),
            paths: mode === "root" ? [] : ["source"],
            roots: mode === "root" ? ["root"] : [],
            workingDirectory: directory,
            runtimeDirectory: "runtime",
          });
          assert.equal(result.code, "output-failed");
          assert.equal(result.importId, null);
          assert.equal(result.included, 0);
          assert.equal(result.refused, 0);
          assert.deepEqual(
            [result.excluded, result.pending],
            mode === "root" ? [0, 0] : [undefined, undefined],
          );
          assert.equal(observer.injected.length, 1);
          assert.ok(observer.handles.every((handle) => handle.fd === -1));
          const files = await readdir(join(directory, "runtime"), {
            recursive: true,
          });
          assert.ok(
            files
              .filter((file) => !file.includes(previous?.importId ?? "\0"))
              .every((file) => !file.endsWith("coverage.json")),
          );
        } finally {
          observer.restore();
        }
      });
    });
  }
}

for (const comparison of [false, true]) {
  await test(`CLV-113 final manifest follows all closed outputs with comparison ${String(comparison)}`, async () => {
    await withFiles({ source }, async (directory) => {
      const previous = comparison ? await initialImport(directory) : undefined;
      const observer = observeCompletion({
        previousOutput: previous?.output,
        required: [
          "corpus.jsonl",
          "structure.json",
          ...(comparison ? ["revision.json"] : []),
        ],
      });
      try {
        const result = await importChats({
          ...(previous === undefined
            ? {}
            : { previousImportId: previous.importId }),
          paths: ["source"],
          workingDirectory: directory,
          runtimeDirectory: "runtime",
        });
        assert.equal(result.code, "import-complete");
        assert.deepEqual(observer.closed, [true]);
        assert.deepEqual(observer.corpusClosed, [true]);
      } finally {
        observer.restore();
      }
    });
  });
}

function interceptFailure(data: {
  readonly name: string;
  readonly operation: string;
  readonly previousOutput: string | undefined;
}) {
  const original = filesystem.open;
  const handles: FileHandle[] = [];
  const injected: string[] = [];
  filesystem.open = async (path, flags) => {
    const output = !String(path).startsWith(data.previousOutput ?? "\0");
    if (
      output &&
      basename(String(path)) === data.name &&
      data.operation === "create"
    ) {
      injected.push(data.operation);
      throw new Error("private-create-error");
    }
    const handle = await original(path, flags, 0o600);
    handles.push(handle);
    if (!output || basename(String(path)) !== data.name) return handle;
    injected.push(data.operation);
    if (data.operation === "write") {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async () => {
        await write('{"schemaVersion":1,');
        throw new Error("private-write-error");
      };
      return handle;
    }
    const close = handle.close.bind(handle);
    handle.close = async () => {
      await close();
      throw new Error("private-close-error");
    };
    return handle;
  };
  syncBuiltinESMExports();
  return {
    handles,
    injected,
    restore() {
      filesystem.open = original;
      syncBuiltinESMExports();
    },
  };
}

function observeCompletion(data: {
  readonly previousOutput: string | undefined;
  readonly required: readonly string[];
}) {
  const original = filesystem.open;
  const handles = new Map<string, FileHandle>();
  const closed: boolean[] = [];
  const corpusClosed: boolean[] = [];
  filesystem.open = async (path, flags) => {
    const name = basename(String(path));
    if (
      name === "coverage.json" &&
      !String(path).startsWith(data.previousOutput ?? "\0")
    )
      closed.push(
        data.required.every((required) => handles.get(required)?.fd === -1),
      );
    if (name === "structure.json")
      corpusClosed.push(handles.get("corpus.jsonl")?.fd === -1);
    const handle = await original(path, flags, 0o600);
    handles.set(name, handle);
    return handle;
  };
  syncBuiltinESMExports();
  return {
    closed,
    corpusClosed,
    restore() {
      filesystem.open = original;
      syncBuiltinESMExports();
    },
  };
}

await test("CLV-113 revision destination refusal is an output failure before coverage completion", async () => {
  await withFiles({ source }, async (directory) => {
    const previous = await initialImport(directory);
    const original = filesystem.open;
    filesystem.open = async (path, flags) => {
      if (basename(String(path)) === "revision.json")
        throw Object.assign(new Error("synthetic-create-refusal"), {
          code: "ELOOP",
        });
      return original(path, flags, 0o600);
    };
    syncBuiltinESMExports();
    try {
      const result = await importChats({
        paths: ["source"],
        workingDirectory: directory,
        runtimeDirectory: "runtime",
        previousImportId: previous.importId,
      });
      assert.equal(result.code, "output-failed");
      const files = await readdir(join(directory, "runtime/chats"), {
        recursive: true,
      });
      assert.equal(
        files.filter((file) => file.endsWith("coverage.json")).length,
        1,
      );
    } finally {
      filesystem.open = original;
      syncBuiltinESMExports();
    }
  });
});
