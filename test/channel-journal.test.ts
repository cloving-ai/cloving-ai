import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { sentEntries } from "../src/cli/channel-journal.ts";
import { withHarness } from "./service-fixture.ts";

const rounds = 25;

const writer = `
import { prunedSent, recordSent } from ${JSON.stringify(new URL("../src/cli/channel-journal.ts", import.meta.url).href)};
const [file, prefix] = process.argv.slice(1);
for (let index = 0; index < ${String(rounds)}; index += 1) {
  await recordSent(file, { key: prefix + "-" + index, runId: "run-" + prefix });
  await prunedSent(file, (entry) => entry.key !== "old-" + prefix + "-" + index);
}
`;

function keys(prefix: string): readonly string[] {
  return Array.from(
    { length: rounds },
    (_, index) => `${prefix}-${String(index)}`,
  );
}

await test("CLV-338 two processes that write the channel journal at the same time keep every entry", () =>
  withHarness(async (harness) => {
    const file = join(harness.runtimeDirectory, "channel-events.json");
    const old = ["a", "b"].flatMap((prefix) => keys(`old-${prefix}`));
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        entries: old.map((key) => ({ key, runId: "run-old" })),
      }),
    );
    const run = promisify(execFile);
    await Promise.all(
      ["a", "b"].map((prefix) =>
        run(process.execPath, [
          "--input-type=module",
          "--eval",
          writer,
          file,
          prefix,
        ]),
      ),
    );
    assert.deepEqual(
      [...(await sentEntries(file)).keys()].toSorted(),
      [...keys("a"), ...keys("b")].toSorted(),
    );
    assert.deepEqual(
      (await readdir(harness.runtimeDirectory)).filter((name) =>
        name.startsWith("channel-events"),
      ),
      ["channel-events.json"],
    );
  }));
