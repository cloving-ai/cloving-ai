import assert from "node:assert/strict";
import {
  mkdir,
  open,
  readFile,
  readdir,
  stat,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { importChats } from "../src/chats/import.ts";
import { normalizeTranscript } from "../src/chats/normalize.ts";
import { runtimeDirectory } from "../src/cli/runtime-directory.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { readRootOutput } from "./chats-selection-fixture.ts";

const source = JSON.stringify({
  type: "user",
  message: { role: "user", content: "private synthetic transcript" },
});

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
  await test(`CLV-110 bounds repeated imports at the total UTF-8 corpus limit plus ${String(extraBytes)} bytes`, async () => {
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
  });
}

await test("CLV-095 selects runtime locations without resolving relative overrides", () => {
  assert.equal(
    runtimeDirectory({
      CLOVING_RUNTIME_DIR: "relative",
      XDG_RUNTIME_DIR: "xdg",
    }),
    "relative",
  );
  assert.equal(
    runtimeDirectory({ CLOVING_RUNTIME_DIR: "", XDG_RUNTIME_DIR: "xdg" }),
    join("xdg", "cloving"),
  );
  assert.equal(
    runtimeDirectory({ XDG_STATE_HOME: "state", HOME: "home" }),
    join("state", "cloving", "run"),
  );
  assert.equal(
    runtimeDirectory({ HOME: "home" }),
    join("home", ".local", "state", "cloving", "run"),
  );
  assert.equal(runtimeDirectory({}), undefined);
});

await test("CLV-095 creates separate private imports and keeps source bytes unchanged", async () => {
  await withFiles({ "source.jsonl": source }, async (directory) => {
    const request = {
      paths: ["source.jsonl"],
      workingDirectory: directory,
      runtimeDirectory: "relative/runtime",
    };
    const first = await importChats(request);
    assert.equal(first.code, "import-complete");
    assert.ok(first.importId);
    const second = await importChats(request);
    assert.ok(second.importId);
    assert.notEqual(first.importId, second.importId);
    const chats = join(directory, "relative/runtime/chats");
    for (const path of [
      "relative",
      "relative/runtime",
      "relative/runtime/chats",
      `relative/runtime/chats/${first.importId}`,
    ]) {
      assert.equal((await stat(join(directory, path))).mode & 0o777, 0o700);
    }
    for (const name of ["corpus.jsonl", "structure.json", "coverage.json"])
      assert.equal(
        (await stat(join(chats, first.importId, name))).mode & 0o777,
        0o600,
      );
    assert.equal(
      await readFile(join(chats, first.importId, "corpus.jsonl"), "utf8"),
      await readFile(join(chats, second.importId, "corpus.jsonl"), "utf8"),
    );
    assert.equal(
      await readFile(join(directory, "source.jsonl"), "utf8"),
      source,
    );
  });
});

await test("CLV-095 refuses unavailable runtime and repository destinations before creating artifacts", async () => {
  await withFiles(
    { "source.jsonl": source, "repo/.git": "gitdir: elsewhere" },
    async (directory) => {
      const unavailable = await importChats({
        paths: ["source.jsonl"],
        workingDirectory: directory,
        runtimeDirectory: undefined,
      });
      assert.equal(unavailable.code, "runtime-directory-unknown");
      assert.equal(unavailable.importId, null);
      await symlink(join(directory, "repo"), join(directory, "alias"));
      await mkdir(join(directory, "outside"));
      await symlink(
        join(directory, "repo"),
        join(directory, "outside", "chats"),
      );
      const before = await readdir(directory, { recursive: true });
      for (const runtime of ["repo/private", "alias/private", "outside"]) {
        const result = await importChats({
          paths: ["source.jsonl"],
          workingDirectory: directory,
          runtimeDirectory: runtime,
        });
        assert.equal(result.code, "destination-refused", runtime);
      }
      assert.deepEqual(await readdir(directory, { recursive: true }), before);
    },
  );
});

await test("CLV-095 leaves no completed manifest after a corpus write failure", async () => {
  await withFiles({ "source.jsonl": source, probe: "" }, async (directory) => {
    const probe = await open(join(directory, "probe"), "r");
    const prototype: unknown = Object.getPrototypeOf(probe);
    assert.ok(
      prototype && typeof prototype === "object" && "writeFile" in prototype,
    );
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "writeFile");
    assert.ok(descriptor);
    Object.defineProperty(prototype, "writeFile", {
      value: () => Promise.reject(new Error("injected private failure")),
      configurable: true,
    });
    try {
      const result = await importChats({
        paths: ["source.jsonl"],
        workingDirectory: directory,
        runtimeDirectory: "runtime",
      });
      assert.equal(result.code, "output-failed");
      const files = await readdir(join(directory, "runtime"), {
        recursive: true,
      });
      assert.ok(files.every((file) => !file.endsWith("coverage.json")));
    } finally {
      Object.defineProperty(prototype, "writeFile", descriptor);
      await probe.close();
    }
  });
});

await test("CLV-111 exclusions alone succeed, pending subtrees require partial status and files remain explicit", async () => {
  await withFiles(
    {
      "root/skip/sentinel.jsonl": source,
      "root/keep/session/subagents/deep/later.jsonl": source,
    },
    async (directory) => {
      const request = {
        paths: [],
        roots: ["root"],
        excludeProjects: ["skip", "keep"],
        workingDirectory: directory,
        runtimeDirectory: "runtime",
      };
      const excluded = await importChats(request);
      assert.equal(excluded.code, "import-complete");
      assert.deepEqual(
        [
          excluded.included,
          excluded.refused,
          excluded.excluded,
          excluded.pending,
        ],
        [0, 0, 2, 0],
      );
      const pending = await importChats({
        ...request,
        excludeProjects: ["skip"],
      });
      assert.equal(pending.code, "import-partial");
      assert.deepEqual(
        [pending.included, pending.refused, pending.excluded, pending.pending],
        [0, 0, 1, 1],
      );
      assert.ok(pending.importId);
      const output = await readRootOutput(directory, pending.importId);
      assert.doesNotMatch(output.coverage, /later.jsonl|sentinel.jsonl/);
      const later = await importChats({
        ...request,
        paths: ["root/keep/session/subagents/deep/later.jsonl"],
        roots: [],
      });
      assert.equal(later.code, "import-complete");
      assert.equal(later.included, 1);
      for (const name of ["corpus.jsonl", "coverage.json", "structure.json"])
        assert.equal(
          (await stat(join(output.output, name))).mode & 0o777,
          0o600,
        );
    },
  );
});

await test("CLV-111 mixed imports share the normalized corpus limit and preserve oversized status forms", async () => {
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
});

async function writeLarge(path: string) {
  const handle = await open(path, "w");
  try {
    await handle.truncate(10_485_761);
  } finally {
    await handle.close();
  }
}

await test("CLV-113 writes private revisions, increments evidence and preserves earlier files", async () => {
  await withFiles({ "source.jsonl": source }, async (directory) => {
    const request = {
      paths: ["source.jsonl"],
      workingDirectory: directory,
      runtimeDirectory: "runtime",
    };
    const first = await importChats(request);
    assert.ok(first.importId);
    const base = join(directory, "runtime/chats", first.importId);
    const before = await Promise.all(
      ["corpus.jsonl", "structure.json", "coverage.json"].map((name) =>
        readFile(join(base, name)),
      ),
    );
    const second = await importChats({
      ...request,
      previousImportId: first.importId,
    });
    assert.equal(second.code, "import-complete");
    assert.ok(second.importId);
    const output = join(directory, "runtime/chats", second.importId);
    assert.equal((await stat(output)).mode & 0o777, 0o700);
    assert.equal(
      (await stat(join(output, "revision.json"))).mode & 0o777,
      0o600,
    );
    assert.deepEqual(
      await Promise.all(
        ["corpus.jsonl", "structure.json", "coverage.json"].map((name) =>
          readFile(join(base, name)),
        ),
      ),
      before,
    );
    const third = await importChats({
      ...request,
      previousImportId: second.importId,
    });
    assert.ok(third.importId);
    const text = await readFile(
      join(directory, "runtime/chats", third.importId, "revision.json"),
      "utf8",
    );
    assert.match(text, /"evidenceRevision": 2/);
    assert.match(text, /"unchanged": 1/);
    assert.doesNotMatch(text, /synthetic transcript|"text"|"blocks"/);
  });
});
