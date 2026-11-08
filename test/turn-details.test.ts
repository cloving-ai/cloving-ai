import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { operationKey } from "../src/daemon/operation-journal.ts";
import {
  noteReceiptsPlace,
  retentionExpiry,
  turnDetailsPlace,
} from "../src/daemon/turn-details.ts";
import { withSweep } from "./record-sweep-fixture.ts";

const turn = operationKey("op-1");

await test("CLV-271 turn details are archived when a turn folder of the run is in the journal folder of the archive", () =>
  withSweep(async (scene) => {
    const place = turnDetailsPlace(scene.settings());
    await scene.folder(`archive/journal/${turn}`, { runId: "done" });
    assert.deepEqual(
      await place({ runId: "done", operationIds: ["op-1", "op-2"] }),
      { state: "archived", folder: join(scene.root, "archive/journal") },
    );
    const elsewhere = join(scene.root, "elsewhere");
    const configured = turnDetailsPlace(
      scene.settings({
        retention: { days: 30, action: "archive", archiveFolder: elsewhere },
      }),
    );
    assert.equal(
      await configured({ runId: "done", operationIds: ["op-1"] }),
      undefined,
    );
    await scene.folder(`elsewhere/journal/${turn}`, { runId: "done" });
    assert.deepEqual(
      await configured({ runId: "done", operationIds: ["op-1"] }),
      { state: "archived", folder: join(elsewhere, "journal") },
    );
  }));

await test("CLV-271 turn details are deleted only for a due run with the delete action and no kept turn folder", () =>
  withSweep(async (scene) => {
    const deleting = (days: number | null) =>
      turnDetailsPlace(
        scene.settings({
          retention: { days, action: "delete", archiveFolder: null },
        }),
      );
    assert.deepEqual(
      await deleting(30)({ runId: "done", operationIds: ["op-1"] }),
      { state: "deleted" },
    );
    for (const runId of ["fresh", "gate", "unknown"])
      assert.equal(
        await deleting(30)({ runId, operationIds: ["op-1"] }),
        undefined,
        runId,
      );
    assert.equal(
      await deleting(null)({ runId: "done", operationIds: ["op-1"] }),
      undefined,
    );
    assert.equal(
      await deleting(30)({ runId: "done", operationIds: [] }),
      undefined,
    );
    await scene.folder(`journal/${turn}`, { runId: "done" });
    assert.equal(
      await deleting(30)({ runId: "done", operationIds: ["op-1"] }),
      undefined,
    );
    assert.equal(
      await turnDetailsPlace(scene.settings())({
        runId: "done",
        operationIds: ["op-1"],
      }),
      undefined,
    );
  }));

await test("CLV-271 turn details stay unknown when a read of a journal folder fails for a reason other than absence", async () => {
  for (const blocked of ["journal", "archive"])
    await withSweep(async (scene) => {
      await writeFile(join(scene.root, blocked), "");
      assert.equal(
        await turnDetailsPlace(
          scene.settings({
            retention: { days: 30, action: "delete", archiveFolder: null },
          }),
        )({ runId: "done", operationIds: ["op-1"] }),
        undefined,
        blocked,
      );
    });
});

await test("CLV-307 a run is past retention for a continuation only when it ended before the retention period", () =>
  withSweep(async (scene) => {
    const expired = retentionExpiry(scene.settings());
    assert.equal(await expired("done"), true);
    for (const runId of ["fresh", "gate", "unknown"])
      assert.equal(await expired(runId), false, runId);
    const kept = retentionExpiry(
      scene.settings({
        retention: { days: null, action: "archive", archiveFolder: null },
      }),
    );
    assert.equal(await kept("done"), false);
  }));

await test("CLV-326 note receipts come from the journal folder and from the journal folder of the archive", () =>
  withSweep(async (scene) => {
    const started = (noteId: string) => ({
      phase: "running",
      attempt: 1,
      processId: 4321,
      notes: [noteId],
    });
    await scene.folder(`archive/journal/${turn}`, started("note-a"));
    await scene.folder(`journal/${operationKey("op-2")}`, started("note-b"));
    const operationIds = ["op-1", "op-2", "op-3"];
    assert.deepEqual(
      await noteReceiptsPlace(scene.settings()).read(operationIds),
      {
        "note-a": "op-1",
        "note-b": "op-2",
      },
    );
    const elsewhere = join(scene.root, "elsewhere");
    await scene.folder(
      `elsewhere/journal/${operationKey("op-3")}`,
      started("note-c"),
    );
    const configured = noteReceiptsPlace(
      scene.settings({
        retention: { days: 30, action: "archive", archiveFolder: elsewhere },
      }),
    );
    assert.deepEqual(await configured.read(operationIds), {
      "note-b": "op-2",
      "note-c": "op-3",
    });
  }));
