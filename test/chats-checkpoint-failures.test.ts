import assert from "node:assert/strict";
import { chmod, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { batch } from "./chats-analysis-merge-fixture.ts";
import { chatPlatformScenario } from "./chats-platform-fixture.ts";
import { withCheckpoints } from "./chats-checkpoint-fixture.ts";

for (const position of [
  { batchIndex: -1, nextRecordIndex: 4 },
  { batchIndex: 4, nextRecordIndex: 4 },
  { batchIndex: 0.5, nextRecordIndex: 4 },
  { batchIndex: 0, nextRecordIndex: 0 },
  { batchIndex: 0, nextRecordIndex: 17 },
  { batchIndex: 0, nextRecordIndex: 1.5 },
]) {
  await test(
    `CLV-158 refuses invalid checkpoint position ${JSON.stringify(position)} without changing coverage`,
    chatPlatformScenario(async () => {
      await withCheckpoints(async (fixture) => {
        const before = await readdir(fixture.folder);
        await assert.rejects(
          fixture.save({ ...position, candidate: batch(), mode: "deliver" }),
          { message: "analysis-input-refused" },
        );
        assert.deepEqual(await readdir(fixture.folder), before);
      });
    }),
  );
}

for (const mutation of [
  "missing-result",
  "invalid-result",
  "changed-coverage",
]) {
  await test(
    `CLV-158 refuses a damaged earlier checkpoint (${mutation}) without committing the next batch`,
    chatPlatformScenario(async () => {
      await withCheckpoints(async (fixture) => {
        const first = await fixture.save({
          candidate: batch(),
          batchIndex: 0,
          nextRecordIndex: 4,
          mode: "deliver",
        });
        assert.ok("checkpoint" in first);
        const checkpoint = first.checkpoint;
        const variants: Readonly<Record<string, unknown>> = {
          "missing-result": { ...checkpoint, result: null },
          "invalid-result": { ...checkpoint, result: {} },
          "changed-coverage": { ...checkpoint, covered: 3, uncovered: 13 },
        };
        const path = join(fixture.folder, "analysis-checkpoint-1.json");
        const damaged = JSON.stringify(variants[mutation]) + "\n";
        await writeFile(path, damaged);
        await assert.rejects(
          fixture.save({
            candidate: batch(),
            batchIndex: 1,
            nextRecordIndex: 8,
            mode: "deliver",
          }),
          { message: "analysis-output-failed" },
        );
        assert.equal(await readFile(path, "utf8"), damaged);
        await assert.rejects(
          readFile(join(fixture.folder, "analysis-checkpoint-2.json")),
          { code: "ENOENT" },
        );
      });
    }),
  );
}

await test(
  "CLV-158 reconciliation refuses a widened private batch claim without changing its bytes",
  chatPlatformScenario(async () => {
    await withCheckpoints(async (fixture) => {
      const input = {
        candidate: batch(),
        batchIndex: 0,
        nextRecordIndex: 4,
        mode: "deliver" as const,
      };
      assert.equal((await fixture.save(input)).kind, "committed");
      const path = join(fixture.folder, "batch-claim-0.json");
      const before = await readFile(path, "utf8");
      await chmod(path, 0o644);
      await assert.rejects(fixture.save({ ...input, mode: "reconcile" }), {
        message: "analysis-output-failed",
      });
      assert.equal(await readFile(path, "utf8"), before);
    });
  }),
);
