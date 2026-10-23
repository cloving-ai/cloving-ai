import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";
import { parseCheckTimeFactor } from "../quality/test-execution.ts";

await test("CLV-136 Darwin chat adapter control flow uses isolated filesystem substitutes on Linux", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      resolve("test/chats-darwin-files-fixture.ts"),
      "--test",
      "--test-concurrency=1",
      "test/chats-cli-flow.test.ts",
      "test/chats-destination.test.ts",
      "test/chats-destination-race.test.ts",
      "test/chats-isolation.test.ts",
      "test/chats-output-failures.test.ts",
      "test/chats-storage.test.ts",
      "test/chats-corpus-limit.test.ts",
      "test/chats-source.test.ts",
      "test/chats-selection.test.ts",
      "test/chats-selection-races.test.ts",
      "test/chats-reader-failures.test.ts",
      "test/chats-revision-import.test.ts",
      "test/chats-revision-storage.test.ts",
      "test/chats-redact-failures.test.ts",
      "test/chats-redact-isolation.test.ts",
      "test/chats-redact-storage.test.ts",
      "test/chats-redact-coverage.test.ts",
      "test/chats-redact-streaming.test.ts",
      "test/chats-reader.test.ts",
      "test/chats-worker.test.ts",
      "test/chats-worker-input.test.ts",
      "test/chats-worker-save.test.ts",
      "test/chats-worker-storage.test.ts",
      "test/chats-analysis-capture.test.ts",
      "test/chats-analysis-capture-failures.test.ts",
      "test/chats-analysis-capture-restart.test.ts",
      "test/chats-analysis-save-bounds.test.ts",
      "test/chats-analysis-checkpoints.test.ts",
      "test/chats-checkpoint-storage.test.ts",
      "test/chats-checkpoint-failures.test.ts",
      "test/chats-checkpoint-conflicts.test.ts",
      "test/chats-analysis-batch-binding.test.ts",
      "test/chats-analysis-batch-question.test.ts",
    ],
    {
      encoding: "utf8",
      timeout:
        120_000 *
        parseCheckTimeFactor(process.env["CLOVING_CHECK_TIME_FACTOR"]),
      maxBuffer: 4_194_304,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => name !== "NODE_TEST_CONTEXT",
        ),
      ),
    },
  );
  assert.match(result.stdout, /tests [1-9]\d*/);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
