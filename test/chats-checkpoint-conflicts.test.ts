import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { captureAnalysisSnapshot } from "../src/daemon/chats-capture.ts";
import { saveAnalysisCheckpoint } from "../src/daemon/chats-checkpoints.ts";
import { batch } from "./chats-analysis-merge-fixture.ts";
import { ref } from "./chats-analysis-fixture.ts";
import { chatPlatformScenario } from "./chats-platform-fixture.ts";
import { withAnalysis, importId, cycleId } from "./chats-worker-fixture.ts";
import { digestOf } from "./service-fixture.ts";

async function conflictInput(directory: string) {
  const capture = await captureAnalysisSnapshot(directory, {
    runId: cycleId,
    importId,
  });
  for (const [batchIndex, nextRecordIndex] of [
    [0, 4],
    [1, 8],
  ] as const)
    assert.equal(
      (
        await saveAnalysisCheckpoint(directory, {
          capture,
          candidate: batch([ref(1)]),
          batchIndex,
          nextRecordIndex,
          mode: "deliver",
        })
      ).kind,
      "committed",
    );
  const folder = join(directory, `capture-${capture.key}`);
  const accepted = join(folder, "analysis-checkpoint-2.json");
  const before = await readFile(accepted, "utf8");
  const base = batch([ref(9)]);
  const candidate = {
    ...base,
    process: { ...base.process, name: "Private conflicting variant" },
  };
  const input = {
    capture,
    candidate,
    batchIndex: 2,
    nextRecordIndex: 12,
    mode: "deliver" as const,
  };
  return { capture, folder, accepted, before, candidate, input };
}

await test(
  "CLV-158 a third-batch merge conflict keeps both variants private and the second checkpoint partial",
  chatPlatformScenario(async () => {
    await withAnalysis(async (fixture) => {
      const { capture, folder, accepted, before, candidate, input } =
        await conflictInput(fixture.directory);
      const outcome = await saveAnalysisCheckpoint(fixture.directory, input);
      assert.deepEqual(outcome, {
        kind: "refused",
        codes: ["analysis-merge-conflict"],
      });
      const path = join(folder, "conflict-2.json");
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
        schemaVersion: 1,
        runId: cycleId,
        importId,
        capturedDigest: capture.digest,
        batchIndex: 2,
        nextRecordIndex: 12,
        accepted: {
          file: "analysis-checkpoint-2.json",
          digest: digestOf(before).slice("sha256:".length),
        },
        incoming: {
          file: "conflict-2-incoming.json",
          digest: digestOf(JSON.stringify(candidate) + "\n").slice(
            "sha256:".length,
          ),
        },
      });
      assert.deepEqual(
        JSON.parse(
          await readFile(join(folder, "conflict-2-incoming.json"), "utf8"),
        ),
        candidate,
      );
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal((await stat(folder)).mode & 0o777, 0o700);
      assert.equal(await readFile(accepted, "utf8"), before);
      await assert.rejects(
        readFile(join(folder, "analysis-checkpoint-3.json")),
        { code: "ENOENT" },
      );
      const metadata = await stat(path);
      assert.deepEqual(
        await saveAnalysisCheckpoint(fixture.directory, input),
        outcome,
      );
      assert.equal((await stat(path)).ino, metadata.ino);
      assert.equal(
        JSON.stringify(outcome).includes(candidate.process.name),
        false,
      );
    });
  }),
);

await test(
  "CLV-158 conflict reconciliation observes both private variants without creating or rewriting them",
  chatPlatformScenario(async () => {
    await withAnalysis(async (fixture) => {
      const { folder, input } = await conflictInput(fixture.directory);
      const reconcile = { ...input, mode: "reconcile" as const };
      assert.deepEqual(
        await saveAnalysisCheckpoint(fixture.directory, reconcile),
        { kind: "absent" },
      );
      for (const name of ["conflict-2.json", "conflict-2-incoming.json"])
        await assert.rejects(readFile(join(folder, name)), { code: "ENOENT" });
      const outcome = await saveAnalysisCheckpoint(fixture.directory, input);
      const path = join(folder, "conflict-2-incoming.json");
      const before = await readFile(path, "utf8");
      const metadata = await stat(path);
      assert.deepEqual(
        await saveAnalysisCheckpoint(fixture.directory, reconcile),
        outcome,
      );
      assert.equal(await readFile(path, "utf8"), before);
      assert.equal((await stat(path)).ino, metadata.ino);
      assert.equal(metadata.mode & 0o777, 0o600);
    });
  }),
);
