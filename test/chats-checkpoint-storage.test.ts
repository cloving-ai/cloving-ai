import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { batch, questionBatch } from "./chats-analysis-merge-fixture.ts";
import { chatPlatformScenario } from "./chats-platform-fixture.ts";
import { withCheckpoints } from "./chats-checkpoint-fixture.ts";

await test(
  "CLV-158 checkpoint replay preserves bytes, inode and receipt and rejects conflicting content",
  chatPlatformScenario(async () => {
    await withCheckpoints(async (fixture) => {
      const input = {
        candidate: batch(),
        batchIndex: 0,
        nextRecordIndex: 4,
        mode: "deliver" as const,
      };
      const first = await fixture.save(input);
      assert.equal(first.kind, "committed");
      const path = join(fixture.folder, "analysis-checkpoint-1.json");
      const bytes = await readFile(path, "utf8");
      const metadata = await stat(path);
      assert.deepEqual(await fixture.save(input), first);
      assert.deepEqual(
        await fixture.save({ ...input, mode: "reconcile" }),
        first,
      );
      const candidate = {
        ...batch(),
        process: { ...batch().process, name: "Different accepted inference" },
      };
      await assert.rejects(fixture.save({ ...input, candidate }), {
        message: "analysis-output-failed",
      });
      assert.equal(await readFile(path, "utf8"), bytes);
      assert.equal((await stat(path)).ino, metadata.ino);
    });
  }),
);

await test(
  "CLV-158 shortening a partial proposal preserves status and counts before private inference text",
  chatPlatformScenario(async () => {
    await withCheckpoints(async (fixture) => {
      const base = batch();
      const candidate = {
        ...base,
        process: {
          ...base.process,
          inputs: Array.from({ length: 25 }, (_, index) => ({
            id: `input-${String(index)}`,
            description: "Private synthetic description ".repeat(20),
          })),
        },
      };
      assert.equal(
        (
          await fixture.save({
            candidate,
            batchIndex: 0,
            nextRecordIndex: 4,
            mode: "deliver",
          })
        ).kind,
        "committed",
      );
      const text = await readFile(
        join(fixture.folder, "proposal-checkpoint-1.txt"),
        "utf8",
      );
      assert.match(
        text,
        /^Status: partial; total 16; covered 4; uncovered 12\.\n/,
      );
      assert.ok(text.length <= 4_000);
      assert.match(text, /Summary shortened/);
    });
  }),
);

await test(
  "CLV-158 two large conflicting variants survive in separate bounded private files",
  chatPlatformScenario(async () => {
    await withCheckpoints(async (fixture) => {
      const base = batch();
      const candidate = {
        ...base,
        process: { ...base.process, name: "a".repeat(35_000) },
      };
      const input = {
        candidate,
        batchIndex: 0,
        nextRecordIndex: 4,
        mode: "deliver" as const,
      };
      assert.equal((await fixture.save(input)).kind, "committed");
      const incoming = {
        ...candidate,
        process: { ...candidate.process, name: "b".repeat(35_000) },
      };
      assert.deepEqual(
        await fixture.save({
          ...input,
          candidate: incoming,
          batchIndex: 1,
          nextRecordIndex: 8,
        }),
        { kind: "refused", codes: ["analysis-merge-conflict"] },
      );
      const path = join(fixture.folder, "conflict-1-incoming.json");
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), incoming);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.ok((await stat(path)).size <= 65_536);
      const accepted = join(fixture.folder, "analysis-checkpoint-1.json");
      assert.ok(
        (await readFile(accepted, "utf8")).includes(candidate.process.name),
      );
      assert.ok((await stat(accepted)).size <= 65_536);
    });
  }),
);

await test(
  "CLV-158 absent reconciliation and invalid validation never advance coverage or write a checkpoint",
  chatPlatformScenario(async () => {
    await withCheckpoints(async (fixture) => {
      const before = await readdir(fixture.folder);
      const input = {
        candidate: batch(),
        batchIndex: 0,
        nextRecordIndex: 4,
        mode: "reconcile" as const,
      };
      assert.equal((await fixture.save(input)).kind, "absent");
      assert.deepEqual(
        await fixture.save({
          ...input,
          candidate: { schemaVersion: 1 },
          mode: "deliver",
        }),
        {
          kind: "refused",
          codes: ["invalid-shape"],
        },
      );
      assert.deepEqual(await readdir(fixture.folder), before);
    });
  }),
);

await test(
  "CLV-158 full coverage with an unresolved question remains partial",
  chatPlatformScenario(async () => {
    await withCheckpoints(async (fixture) => {
      const outcome = await fixture.save({
        candidate: questionBatch(),
        batchIndex: 0,
        nextRecordIndex: 16,
        mode: "deliver",
      });
      assert.equal(outcome.kind, "committed");
      assert.ok("checkpoint" in outcome);
      assert.equal(outcome.checkpoint.status, "partial");
      assert.equal(outcome.checkpoint.covered, 16);
      assert.equal(outcome.checkpoint.uncovered, 0);
      assert.ok(outcome.checkpoint.result.openQuestion);
    });
  }),
);

await test(
  "CLV-158 a retained merge conflict cannot be silently replaced with another batch candidate",
  chatPlatformScenario(async () => {
    await withCheckpoints(async (fixture) => {
      const input = {
        candidate: batch(),
        batchIndex: 0,
        nextRecordIndex: 4,
        mode: "deliver" as const,
      };
      assert.equal((await fixture.save(input)).kind, "committed");
      const candidate = {
        ...batch(),
        process: { ...batch().process, name: "Private conflicting inference" },
      };
      const next = { ...input, batchIndex: 1, nextRecordIndex: 8 };
      assert.deepEqual(await fixture.save({ ...next, candidate }), {
        kind: "refused",
        codes: ["analysis-merge-conflict"],
      });
      await assert.rejects(fixture.save(next), {
        message: "analysis-output-failed",
      });
      await assert.rejects(
        readFile(join(fixture.folder, "analysis-checkpoint-2.json")),
        { code: "ENOENT" },
      );
    });
  }),
);
