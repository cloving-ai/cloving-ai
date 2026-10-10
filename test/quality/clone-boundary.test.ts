import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cloneArguments } from "../../quality/clone-arguments.ts";

for (const [extension, count] of [
  ["ts", 149],
  ["ts", 150],
  ["js", 149],
  ["js", 150],
] as const) {
  await test(`QG-14 lexical clone boundary at ${String(count)} tokens in ${extension}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "cloving-clones-"));
    try {
      const expression = Array.from(
        { length: 75 },
        (_, index) => `value${String(index)}`,
      ).join(" + ");
      const source = count === 150 ? `${expression};` : expression;
      await writeFile(join(directory, `first.${extension}`), source);
      await writeFile(join(directory, `second.${extension}`), source);
      const result = spawnSync(
        process.execPath,
        cloneArguments([directory], {
          report: join(directory, "report"),
          maximumBytes: 4096,
        }),
        { encoding: "utf8", timeout: 10000 },
      );
      assert.equal(result.status, count === 150 ? 1 : 0, result.stderr);
      const report: unknown = JSON.parse(
        await readFile(join(directory, "report/jscpd-report.json"), "utf8"),
      );
      assert.ok(
        typeof report === "object" && report !== null && "duplicates" in report,
      );
      assert.ok(Array.isArray(report.duplicates));
      assert.equal(report.duplicates.length, count === 150 ? 1 : 0);
    } finally {
      await rm(directory, { recursive: true });
    }
  });
}
