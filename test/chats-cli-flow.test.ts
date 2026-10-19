import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli/main.ts";
import { chatPlatformScenario } from "./chats-platform-fixture.ts";
import {
  base,
  files,
  importId,
  expectedRedacted,
} from "./chats-redact-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";

async function invoke(request: {
  readonly directory: string;
  readonly argumentsList: readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
}) {
  const previous = {
    directory: process.cwd(),
    environment: process.env,
    exitCode: process.exitCode,
    out: process.stdout.write.bind(process.stdout),
    error: process.stderr.write.bind(process.stderr),
  };
  let stdout = "";
  let stderr = "";
  process.stdout.write = (text) => {
    stdout += String(text);
    return true;
  };
  process.stderr.write = (text) => {
    stderr += String(text);
    return true;
  };
  process.env = { ...request.environment };
  process.chdir(request.directory);
  try {
    await main(request.argumentsList);
    return { stdout, stderr, status: process.exitCode };
  } finally {
    process.chdir(previous.directory);
    process.env = previous.environment;
    process.exitCode = previous.exitCode;
    process.stdout.write = previous.out;
    process.stderr.write = previous.error;
  }
}

await test(
  "CLV-136 direct chat redaction rejects missing runtime and invalid settings without outputs",
  chatPlatformScenario(async () => {
    await withFiles(files, async (directory) => {
      const unavailable = await invoke({
        directory,
        argumentsList: ["chats", "redact", importId],
      });
      assert.equal(unavailable.status, 1);
      assert.match(unavailable.stdout, /runtime-directory-unknown/);
      for (const setting of ["sentinel", "{}", "null", "[1]", '[" "]']) {
        const invalid = await invoke({
          directory,
          argumentsList: ["chats", "redact", importId],
          environment: {
            CLOVING_RUNTIME_DIR: join(directory, "runtime"),
            CLOVING_PRIVATE_TEXTS: setting,
          },
        });
        assert.equal(invalid.status, 1);
        assert.match(invalid.stdout, /invalid-settings/);
        assert.equal(invalid.stderr, "");
      }
      assert.deepEqual((await readdir(join(directory, base))).sort(), [
        "corpus.jsonl",
        "coverage.json",
      ]);
    });
  }),
);

await test(
  "CLV-136 direct chat redaction reports success and missing evidence",
  chatPlatformScenario(async () => {
    await withFiles(files, async (directory) => {
      const complete = await invoke({
        directory,
        argumentsList: ["chats", "redact", importId],
        environment: {
          CLOVING_RUNTIME_DIR: join(directory, "runtime"),
          CLOVING_PRIVATE_TEXTS: '["Private Phrase"]',
          HOME: "/synthetic/home/operator",
        },
      });
      assert.equal(complete.status, 0);
      assert.match(complete.stdout, /redaction-complete/);
      assert.equal(complete.stderr, "");
      assert.equal(
        await readFile(join(directory, base, "redacted.jsonl"), "utf8"),
        expectedRedacted,
      );
      const missing = await invoke({
        directory,
        argumentsList: ["chats", "redact", importId],
        environment: { CLOVING_RUNTIME_DIR: join(directory, "absent") },
      });
      assert.equal(missing.status, 1);
      assert.match(missing.stdout, /redaction-failed/);
      assert.equal(missing.stderr, "");
    });
  }),
);

await test(
  "CLV-136 direct chat import reports complete, partial and unavailable runtime results",
  chatPlatformScenario(async () => {
    const source = JSON.stringify({
      type: "user",
      message: { role: "user", content: "selected source" },
    });
    await withFiles({ "source.jsonl": source }, async (directory) => {
      const unavailable = await invoke({
        directory,
        argumentsList: ["chats", "import", "source.jsonl"],
      });
      assert.equal(unavailable.status, 1);
      assert.match(unavailable.stdout, /runtime-directory-unknown/);
      for (const [path, code, status] of [
        ["source.jsonl", "import-complete", 0],
        ["missing.jsonl", "import-partial", 1],
      ] as const) {
        const imported = await invoke({
          directory,
          argumentsList: ["chats", "import", path],
          environment: { CLOVING_RUNTIME_DIR: join(directory, "runtime") },
        });
        assert.equal(imported.status, status);
        assert.match(imported.stdout, new RegExp(code));
        assert.equal(imported.stderr, "");
      }
      assert.equal(
        await readFile(join(directory, "source.jsonl"), "utf8"),
        source,
      );
    });
  }),
);
