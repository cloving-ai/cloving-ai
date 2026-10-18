import assert from "node:assert/strict";
import filesystem, {
  link,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { importChats } from "../src/chats/import.ts";
import { withFiles } from "./quality/files-fixture.ts";
import {
  coverage,
  entry,
  importId,
  revision,
  request,
  source,
} from "./chats-revision-fixture.ts";

const base = `runtime/chats/${importId}`;
const valid = JSON.stringify(coverage);
for (const [name, coverageText, revisionText] of [
  ["missing coverage", undefined, undefined],
  ["invalid coverage", "{", undefined],
  ["wrong ID", JSON.stringify({ ...coverage, importId: "other" }), undefined],
  [
    "invalid digest",
    JSON.stringify({ ...coverage, files: [{ ...entry, digest: "bad" }] }),
    undefined,
  ],
  [
    "invalid size",
    JSON.stringify({ ...coverage, files: [{ ...entry, byteSize: -1 }] }),
    undefined,
  ],
  ["malformed revision", valid, "{"],
  [
    "zero revision",
    valid,
    JSON.stringify({ ...revision, evidenceRevision: 0 }),
  ],
  [
    "overflow revision",
    valid,
    JSON.stringify({ ...revision, evidenceRevision: Number.MAX_SAFE_INTEGER }),
  ],
] as const) {
  await test(`CLV-113 refuses ${name} before source selection and output`, async () => {
    const files = {
      source,
      [`${base}/sentinel`]: "unchanged",
      ...(coverageText === undefined
        ? {}
        : { [`${base}/coverage.json`]: coverageText }),
      ...(revisionText === undefined
        ? {}
        : { [`${base}/revision.json`]: revisionText }),
    };
    await withFiles(files, async (directory) => {
      const before = await readdir(directory, { recursive: true });
      const original = filesystem.open;
      const opened: string[] = [];
      filesystem.open = (path, flags) => {
        opened.push(String(path));
        return original(path, flags);
      };
      syncBuiltinESMExports();
      try {
        const result = await importChats({
          ...request(directory),
          roots: ["root-must-not-be-scanned"],
          previousImportId: importId,
        });
        assert.equal(result.code, "previous-import-refused");
        assert.equal(result.importId, null);
        assert.ok(
          Object.values(result)
            .filter((value) => typeof value === "number")
            .every((value) => value === 0),
        );
        assert.ok(
          opened.every((path) => path.startsWith(join(directory, base))),
        );
      } finally {
        filesystem.open = original;
        syncBuiltinESMExports();
      }
      assert.deepEqual(await readdir(directory, { recursive: true }), before);
    });
  });
}

for (const name of ["coverage.json", "revision.json"]) {
  for (const kind of ["symbolic", "hard", "directory"] as const) {
    await test(`CLV-113 refuses ${kind} linked or nonregular ${name}`, async () => {
      await withFiles(
        {
          source,
          [`${base}/coverage.json`]: valid,
          [`${base}/revision.json`]: JSON.stringify(revision),
        },
        async (directory) => {
          const path = join(directory, base, name);
          const text = await readFile(path);
          await rm(path);
          const target = join(directory, "target");
          await writeFile(target, text);
          if (kind === "symbolic") await symlink(target, path);
          if (kind === "hard") await link(target, path);
          if (kind === "directory") await mkdir(path);
          const before = await readdir(join(directory, "runtime/chats"));
          const result = await importChats({
            ...request(directory),
            previousImportId: importId,
          });
          assert.equal(result.code, "previous-import-refused");
          assert.deepEqual(
            await readdir(join(directory, "runtime/chats")),
            before,
          );
          assert.deepEqual(await readFile(target), text);
        },
      );
    });
  }
}

await test("CLV-113 refuses malformed direct IDs and non-directory earlier imports without output", async () => {
  await withFiles(
    { source, [base]: "synthetic-nondirectory" },
    async (directory) => {
      const before = await readdir(directory, { recursive: true });
      for (const previousImportId of ["malformed", "../synthetic", importId]) {
        const result = await importChats({
          ...request(directory),
          previousImportId,
        });
        assert.equal(result.code, "previous-import-refused");
        assert.equal(result.importId, null);
      }
      assert.deepEqual(await readdir(directory, { recursive: true }), before);
    },
  );
});

await test("CLV-113 refuses inaccessible optional revision metadata before source access", async () => {
  await withFiles(
    { source, [`${base}/coverage.json`]: valid },
    async (directory) => {
      const original = filesystem.lstat;
      const descriptor = Object.getOwnPropertyDescriptor(filesystem, "lstat");
      assert.ok(descriptor);
      const before = await readdir(directory, { recursive: true });
      Object.defineProperty(filesystem, "lstat", {
        configurable: true,
        value: async (path: string) => {
          if (path === join(directory, base, "revision.json"))
            throw Object.assign(new Error("synthetic-access-error"), {
              code: "EACCES",
            });
          return original(path);
        },
      });
      syncBuiltinESMExports();
      try {
        const result = await importChats({
          ...request(directory),
          previousImportId: importId,
        });
        assert.equal(result.code, "previous-import-refused");
        assert.equal(result.included, 0);
        assert.equal(result.refused, 0);
        assert.deepEqual(await readdir(directory, { recursive: true }), before);
      } finally {
        Object.defineProperty(filesystem, "lstat", descriptor);
        syncBuiltinESMExports();
      }
    },
  );
});
