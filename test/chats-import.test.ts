import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { withProject } from "./cli-fixture.ts";
import { parseCorpus } from "../src/chats/corpus-input.ts";
import { structureImport } from "../src/chats/structure.ts";
import { parseInvocation } from "../src/cli/arguments.ts";

const messages = [
  { type: "user", message: { role: "user", content: "selected private text" } },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call-1",
          name: "Shell",
          input: { command: "false" },
        },
      ],
    },
  },
  {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call-1",
          content: "result",
          is_error: false,
        },
      ],
    },
  },
]
  .map((message) => JSON.stringify(message))
  .join("\n");

await test("CLV-095 imports only selected transcripts without a daemon", async () => {
  await withProject(
    {
      "project with spaces/selected-a.jsonl": messages,
      "project with spaces/selected-b.jsonl": "invalid JSON",
      "project with spaces/sentinel.jsonl": "unselected sentinel text",
    },
    async (_cli, directory) => {
      const runtime = join(directory, "private-runtime");
      const result = spawnSync(
        process.execPath,
        [
          resolve("src/cli.ts"),
          "chats",
          "import",
          "--",
          "selected-a.jsonl",
          "selected-b.jsonl",
        ],
        {
          cwd: directory,
          encoding: "utf8",
          env: { ...process.env, CLOVING_RUNTIME_DIR: runtime },
        },
      );
      assert.equal(result.status, 1);
      const imports = await readdir(join(runtime, "chats"));
      assert.equal(imports.length, 1);
      const imported = join(runtime, "chats", String(imports[0]));
      const corpus = (await readFile(join(imported, "corpus.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line): unknown => JSON.parse(line));
      assert.equal(corpus.length, 3);
      const coverage: unknown = JSON.parse(
        await readFile(join(imported, "coverage.json"), "utf8"),
      );
      assert.ok(
        coverage && typeof coverage === "object" && "files" in coverage,
      );
      assert.ok(Array.isArray(coverage.files));
      assert.deepEqual(
        coverage.files.map((entry: { status: string }) => entry.status),
        ["included", "unsupported"],
      );
      assert.equal(
        await readFile(join(directory, "selected-a.jsonl"), "utf8"),
        messages,
      );
      assert.equal(
        await readFile(join(directory, "selected-b.jsonl"), "utf8"),
        "invalid JSON",
      );
      assert.doesNotMatch(
        result.stdout + result.stderr,
        /selected-|private text|sentinel|daemon/,
      );
    },
  );
});

await test("CLV-095 help and invalid import usage leave no artifacts", async () => {
  await withProject({}, async (cli, directory) => {
    const before = await readdir(directory, { recursive: true });
    assert.match(cli(["--help"]).stdout, /chats import/);
    const help = cli(["chats", "import", "--help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /cloving chats import \[--\] <path>/);
    for (const args of [[], ["--"], ["--json"], ["--input", "secret"], [""]]) {
      const result = cli(["chats", "import", ...args]);
      assert.equal(result.status, 2);
      assert.equal(result.stdout, "");
      assert.doesNotMatch(result.stderr, /secret/);
    }
    assert.deepEqual(await readdir(directory, { recursive: true }), before);
  });
});

await test("CLV-095 imports relative paths, literal options and missing selected sources", async () => {
  await withProject(
    { "project with spaces/--help": messages },
    async (_cli, directory) => {
      const runtime = join(directory, "runtime");
      const result = spawnSync(
        process.execPath,
        [
          resolve("src/cli.ts"),
          "chats",
          "import",
          "--",
          "--help",
          "missing-private-path",
        ],
        {
          cwd: directory,
          encoding: "utf8",
          env: { ...process.env, CLOVING_RUNTIME_DIR: runtime },
        },
      );
      assert.equal(result.status, 1);
      const output: unknown = JSON.parse(result.stdout);
      assert.ok(
        output &&
          typeof output === "object" &&
          "importId" in output &&
          typeof output.importId === "string",
      );
      const coverage: unknown = JSON.parse(
        await readFile(
          join(runtime, "chats", output.importId, "coverage.json"),
          "utf8",
        ),
      );
      assert.ok(
        coverage &&
          typeof coverage === "object" &&
          "files" in coverage &&
          Array.isArray(coverage.files),
      );
      assert.deepEqual(
        coverage.files.map((file: { status: string }) => file.status),
        ["included", "unreadable"],
      );
      assert.doesNotMatch(
        result.stdout + result.stderr,
        /missing-private-path|--help|selected/,
      );
    },
  );
});

await test("CLV-095 parses explicitly selected paths without application expansion", () => {
  for (const paths of [
    ["a", "b"],
    ["*.jsonl"],
    ["--", "--prompt", "--text", "--help"],
  ]) {
    assert.deepEqual(parseInvocation(["chats", "import", ...paths]), {
      kind: "chats-import",
      paths: paths[0] === "--" ? paths.slice(1) : paths,
    });
  }
});

await test("CLV-095 unavailable runtime exits 1 without reading sources or creating artifacts", async () => {
  await withProject({}, async (_cli, directory) => {
    const before = await readdir(directory, { recursive: true });
    const result = spawnSync(
      process.execPath,
      [resolve("src/cli.ts"), "chats", "import", "missing-private-source"],
      {
        cwd: directory,
        encoding: "utf8",
        env: {},
      },
    );
    assert.equal(result.status, 1);
    const output: unknown = JSON.parse(result.stdout);
    assert.deepEqual(output, {
      code: "runtime-directory-unknown",
      importId: null,
      included: 0,
      refused: 0,
      records: 0,
      knownSessions: 0,
      forks: 0,
      copies: 0,
      conflictGroups: 0,
      unknownIdentities: 0,
      missingParentTargets: 0,
    });
    assert.equal(result.stderr, "");
    assert.deepEqual(await readdir(directory, { recursive: true }), before);
  });
});

const forkMessages = [
  { uuid: "root-id", parentUuid: null },
  { uuid: "first-id", parentUuid: "root-id" },
  { uuid: "side-id", parentUuid: "root-id", isSidechain: true },
].map((identity) => ({
  type: "user",
  sessionId: "private-session",
  ...identity,
  message: { role: "user", content: "synthetic-content-sentinel" },
}));
const forkSource = forkMessages
  .map((message) => JSON.stringify(message))
  .join("\n");
function importSelected(directory: string, paths: readonly string[]) {
  return spawnSync(
    process.execPath,
    [resolve("src/cli.ts"), "chats", "import", ...paths],
    {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, CLOVING_RUNTIME_DIR: join(directory, "runtime") },
    },
  );
}

const counts = {
  records: 8,
  knownSessions: 1,
  forks: 1,
  copies: 3,
  conflictGroups: 1,
  unknownIdentities: 1,
  missingParentTargets: 0,
};

await test("CLV-110 CLI imports forks, copies and conflicts without leaking private metadata", async () => {
  await withProject(
    {
      "project with spaces/a": forkSource,
      "project with spaces/c": JSON.stringify({
        ...forkMessages[1],
        message: { role: "user", content: "conflict-content-sentinel" },
      }),
      "project with spaces/d": JSON.stringify({
        type: "user",
        sessionId: "private-session",
        message: { role: "user", content: "unknown-content-sentinel" },
      }),
    },
    async (_cli, directory) => {
      const runtime = join(directory, "runtime");
      const result = importSelected(directory, ["a", "a", "c", "d", "missing"]);
      assert.equal(result.status, 1);
      assert.equal(result.stderr, "");
      const imports = await readdir(join(runtime, "chats"));
      assert.equal(imports.length, 1);
      const importId = String(imports[0]);
      const output = join(runtime, "chats", importId);
      const records = parseCorpus(
        await readFile(join(output, "corpus.jsonl"), "utf8"),
      );
      assert.equal(records.length, 8);
      const text = await readFile(join(output, "structure.json"), "utf8");
      const structure: unknown = JSON.parse(text);
      assert.deepEqual(structure, {
        schemaVersion: 1,
        importId,
        ...structureImport(records),
      });
      assert.deepEqual(JSON.parse(result.stdout), {
        code: "import-partial",
        importId,
        included: 4,
        refused: 1,
        ...counts,
      });
      assert.doesNotMatch(text, /content-sentinel|"text"|"blocks"|"path"/);
      assert.equal(text.includes(directory), false);
      assert.doesNotMatch(
        result.stdout,
        /private-session|root-id|first-id|side-id|content-sentinel|"missing"/,
      );
      assert.equal(await readFile(join(directory, "a"), "utf8"), forkSource);
    },
  );
});

await test("CLV-110 metadata-only imports write private structure with every zero count", async () => {
  await withProject(
    { "project with spaces/metadata": '{"type":"progress"}' },
    async (_cli, directory) => {
      const runtime = join(directory, "runtime");
      const result = spawnSync(
        process.execPath,
        [resolve("src/cli.ts"), "chats", "import", "metadata"],
        {
          cwd: directory,
          encoding: "utf8",
          env: { ...process.env, CLOVING_RUNTIME_DIR: runtime },
        },
      );
      assert.equal(result.status, 0);
      const imports = await readdir(join(runtime, "chats"));
      const importId = String(imports[0]);
      const text = await readFile(
        join(runtime, "chats", importId, "structure.json"),
        "utf8",
      );
      assert.deepEqual(JSON.parse(text), {
        schemaVersion: 1,
        importId,
        ...structureImport([]),
      });
      assert.deepEqual(JSON.parse(result.stdout), {
        code: "import-complete",
        importId,
        included: 1,
        refused: 0,
        ...structureImport([]).counts,
      });
    },
  );
});
