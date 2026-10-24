import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { assertEmulatedChatTests } from "./chats-darwin-emulation.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

function participant(name: string, other: string): string {
  return `
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
await test("independent emulation files can make progress together", async () => {
  await writeFile(new URL(${JSON.stringify(`./${name}.ready`)}, import.meta.url), "ready");
  const deadline = Date.now() + ${String(testMilliseconds(10000))};
  for (;;) {
    const ready = await readFile(new URL(${JSON.stringify(`./${other}.ready`)}, import.meta.url), "utf8").catch(() => "");
    if (ready === "ready") break;
    assert.ok(Date.now() < deadline, "the other isolated test file must start before this one finishes");
    await delay(10);
  }
});
`;
}

await test("CLV-179 Darwin emulation makes progress across isolated test files without extending its deadline", () =>
  withFiles(
    {
      "first.test.mjs": participant("first", "second"),
      "second.test.mjs": participant("second", "first"),
    },
    async (directory) => {
      assertEmulatedChatTests([
        join(directory, "first.test.mjs"),
        join(directory, "second.test.mjs"),
      ]);
      assert.equal(
        await readFile(join(directory, "first.ready"), "utf8"),
        "ready",
      );
      assert.equal(
        await readFile(join(directory, "second.ready"), "utf8"),
        "ready",
      );
    },
  ));
