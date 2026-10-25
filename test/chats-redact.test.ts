import { chatPlatformScenario } from "./chats-platform-fixture.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { redactImport } from "../src/chats/redact-import.ts";
import { withFiles } from "./quality/files-fixture.ts";

import {
  importId,
  base,
  corpus,
  coverage,
  files,
  digest,
  cli,
  configuredCli,
  expectedRedacted,
} from "./chats-redact-fixture.ts";

await test(
  "CLV-103 CLI redacts an existing import without a daemon and preserves originals",
  chatPlatformScenario(async () => {
    await withFiles(files, async (directory) => {
      const result = cli(directory, ["chats", "redact", importId]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(result.stderr, "");
      const output = join(directory, base);
      const redacted = await readFile(join(output, "redacted.jsonl"), "utf8");
      assert.equal(redacted, expectedRedacted);
      const counts = {
        privateKey: 0,
        credentialUrl: 0,
        homePath: 3,
        token: 3,
        email: 3,
        privateText: 3,
      };
      assert.deepEqual(
        JSON.parse(await readFile(join(output, "redaction.json"), "utf8")),
        {
          schemaVersion: 1,
          importId,
          ruleVersion: 1,
          recordCount: 2,
          counts,
          totalCount: 12,
        },
      );
      assert.deepEqual(JSON.parse(result.stdout), {
        code: "redaction-complete",
        importId,
        recordCount: 2,
        counts,
        totalCount: 12,
      });
      for (const name of ["redacted.jsonl", "redaction.json"])
        assert.equal((await stat(join(output, name))).mode & 0o777, 0o600);
      assert.equal(
        digest(await readFile(join(output, "corpus.jsonl"), "utf8")),
        digest(corpus),
      );
      assert.equal(
        digest(await readFile(join(output, "coverage.json"), "utf8")),
        digest(coverage),
      );
      assert.doesNotMatch(
        result.stdout + result.stderr,
        /synthetic|person@|ghp_|Private Phrase|Error|\//,
      );
    });
  }),
);

await test("CLV-103 help and invalid IDs exit without artifacts", async () => {
  await withFiles({}, async (directory) => {
    assert.match(cli(directory, ["--help"]).stdout, /chats redact/);
    assert.equal(cli(directory, ["chats", "redact", "--help"]).status, 0);
    for (const args of [
      [],
      ["../sentinel"],
      ["01234567-89ab-1cde-8fab-0123456789ab"],
      [importId.toUpperCase()],
      [importId, "extra"],
      ["--json"],
      [""],
    ]) {
      const result = cli(directory, ["chats", "redact", ...args]);
      assert.equal(result.status, 2);
      assert.doesNotMatch(
        result.stdout + result.stderr,
        /sentinel|extra|01234567/,
      );
    }
    assert.deepEqual(await readdir(directory), []);
  });
});

await test(
  "CLV-103 unavailable runtime and malformed settings fail without outputs",
  chatPlatformScenario(async () => {
    await withFiles(files, async (directory) => {
      const before = await readdir(directory, { recursive: true });
      const direct = await redactImport({
        importId,
        workingDirectory: directory,
        runtimeDirectory: undefined,
        settings: { home: null, privateTexts: [] },
      });
      assert.equal(direct.code, "runtime-directory-unknown");
      assert.equal(direct.recordCount, 0);
      assert.equal(direct.totalCount, 0);
      assert.deepEqual(await readdir(directory, { recursive: true }), before);
      const unavailable = spawnSync(
        process.execPath,
        [resolve("src/cli.ts"), "chats", "redact", importId],
        { cwd: directory, encoding: "utf8", env: {} },
      );
      assert.equal(unavailable.status, 1);
      assert.match(unavailable.stdout, /repository-unknown/);
      assert.match(unavailable.stdout, /--repository/);
      for (const setting of [
        "sentinel",
        "{}",
        "null",
        "[1]",
        '[" "]',
        '[""]',
      ]) {
        const result = configuredCli(directory, {
          argumentsList: ["chats", "redact", importId],
          environment: { CLOVING_PRIVATE_TEXTS: setting },
        });
        assert.equal(result.status, 1);
        assert.match(result.stdout, /invalid-settings/);
        assert.doesNotMatch(
          result.stdout + result.stderr,
          /sentinel|SyntaxError/,
        );
      }
      assert.deepEqual((await readdir(join(directory, base))).sort(), [
        "corpus.jsonl",
        "coverage.json",
      ]);
    });
  }),
);
