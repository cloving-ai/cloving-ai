import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { testMilliseconds } from "./test-timing.ts";

const fixture = join(import.meta.dirname, "chats-darwin-files-fixture.ts");

export function darwinChatFileArguments(): readonly string[] {
  if (process.env["CLOVING_TEST_DARWIN_FILES"] !== "1") return [];
  return ["--import", fixture];
}

export function assertEmulatedChatTests(files: readonly string[]): void {
  const result = spawnSync(
    process.execPath,
    ["--import", fixture, "--test", "--test-concurrency=2", ...files],
    {
      encoding: "utf8",
      timeout: testMilliseconds(120_000),
      maxBuffer: 4_194_304,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => name !== "NODE_TEST_CONTEXT",
        ),
      ),
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /tests [1-9]\d*/);
}
