import { chatPlatformScenario } from "./chats-platform-fixture.ts";
import {
  parseObject,
  readJson,
  assertScenarioRevision,
} from "./chats-revision-fixture.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { withProject } from "./cli-fixture.ts";
import { parseInvocation } from "../src/cli/arguments.ts";
import { withFiles } from "./quality/files-fixture.ts";
import {
  assertRootScenario,
  rootScenarioFiles,
} from "./chats-selection-fixture.ts";

await test(
  "CLV-111 imports roots in canonical order with exclusions and link refusals",
  chatPlatformScenario(async () => {
    await withFiles(rootScenarioFiles, async (directory) => {
      await symlink(
        join(directory, "outside"),
        join(directory, "B/project-keep/session-z.jsonl"),
      );
      for (const roots of [
        ["B", "A"],
        ["A", "B"],
      ]) {
        const result = importSelected(directory, [
          ...roots.flatMap((root) => ["--root", root]),
          "--exclude-project",
          "project-skip",
        ]);
        await assertRootScenario(directory, result);
      }
    });
  }),
);

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

await test(
  "CLV-095 imports only selected transcripts without a daemon",
  chatPlatformScenario(async () => {
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
  }),
);

await test("CLV-095 help and invalid import usage leave no artifacts", async () => {
  await withProject({}, async (cli, directory) => {
    const before = await readdir(directory, { recursive: true });
    assert.match(cli(["--help"]).stdout, /chats import/);
    const help = cli(["chats", "import", "--help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /cloving chats import \[--\] <path>/);
    for (const args of [
      [],
      ["--"],
      ["--json"],
      ["--input", "secret"],
      [""],
      ["--root"],
      ["--root", "secret", "--exclude-project", "../secret"],
      ["--exclude-project", "secret"],
    ]) {
      const result = cli(["chats", "import", ...args]);
      assert.equal(result.status, 2);
      assert.equal(result.stdout, "");
      assert.doesNotMatch(result.stderr, /secret/);
    }
    assert.deepEqual(await readdir(directory, { recursive: true }), before);
  });
});

await test(
  "CLV-095 imports relative paths, literal options and missing selected sources",
  chatPlatformScenario(async () => {
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
  }),
);

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

await test(
  "CLV-095 unavailable runtime exits 1 without reading sources or creating artifacts",
  chatPlatformScenario(async () => {
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
        code: "repository-unknown",
        detail:
          "Change to the service repository, use --repository <directory>, or set CLOVING_RUNTIME_DIR.",
      });
      assert.equal(result.stderr, "");
      assert.deepEqual(await readdir(directory, { recursive: true }), before);
    });
  }),
);

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

await test(
  "CLV-113 records explicit extension, truncation, new and missing evidence",
  chatPlatformScenario(async () => {
    const line =
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "synthetic revision" },
      }) + "\r\n";
    await withFiles(
      { A: line, B: line + line, C: line, D: line },
      async (directory) => {
        const first = importSelected(directory, ["A", "B", "C"]);
        assert.equal(first.status, 0);
        const imports = await readdir(join(directory, "runtime/chats"));
        const previousImportId = String(imports[0]);
        await writeFile(join(directory, "A"), line + line);
        await writeFile(join(directory, "B"), line);
        const result = importSelected(directory, [
          "--previous-import",
          previousImportId,
          "A",
          "B",
          "D",
        ]);
        assert.equal(result.status, 1);
        assert.equal(result.stderr, "");
        const summary = parseObject(result.stdout);
        assert.equal(summary["code"], "import-partial");
        assert.equal(summary["included"], 3);
        assert.equal(summary["refused"], 0);
        assert.equal(typeof summary["importId"], "string");
        const revision = await readJson(
          join(
            directory,
            "runtime/chats",
            String(summary["importId"]),
            "revision.json",
          ),
        );
        assertScenarioRevision(directory, revision);
        assert.doesNotMatch(
          result.stdout + result.stderr,
          /synthetic revision|verified-prefix|not-selected/,
        );
      },
    );
  }),
);
