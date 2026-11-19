import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { legacyWorldRefusal } from "../src/host/legacy-world.ts";
import { withFiles } from "./quality/files-fixture.ts";

function run(worldRunId: string, status: string, runId?: string): string {
  return JSON.stringify({
    runId: worldRunId,
    status,
    workflowName: "workflow//./workflows/develop//develop",
    attributes: runId === undefined ? {} : { "cloving.run": runId },
  });
}

await test("#852 the check of earlier Local World data allows a data folder with no JSON runs and a folder whose JSON runs are all finished", () =>
  withFiles(
    {
      "empty/world.db": "",
      "finished/runs/wrun_1.json": run("wrun_1", "completed", "run-a"),
      "finished/runs/wrun_2.json": run("wrun_2", "failed", "run-b"),
      "finished/runs/wrun_3.json": run("wrun_3", "cancelled"),
      "finished/runs/wrun_4.json.tmp.01ABC": "{",
      "finished/runs/notes.txt": "",
    },
    async (directory) => {
      assert.equal(await legacyWorldRefusal(join(directory, "empty")), undefined);
      assert.equal(
        await legacyWorldRefusal(join(directory, "absent")),
        undefined,
      );
      assert.equal(
        await legacyWorldRefusal(join(directory, "finished")),
        undefined,
      );
    },
  ));

await test("#852 the check of earlier Local World data refuses a folder with an unfinished JSON run, and it names each such run and the steps to drain it", () =>
  withFiles(
    {
      "world/runs/wrun_1.json": run("wrun_1", "completed", "run-a"),
      "world/runs/wrun_2.json": run("wrun_2", "running", "run-b"),
      "world/runs/wrun_3.json": run("wrun_3", "pending"),
      "world/runs/wrun_4.json": "{",
    },
    async (directory) => {
      const world = join(directory, "world");
      assert.deepEqual(await legacyWorldRefusal(world), {
        kind: "refused",
        reason: "legacy-world-runs",
        detail: `The Local World folder ${world} holds runs of an earlier Workflow SDK that are not finished: run-b (World run wrun_2, running), World run wrun_3 (pending), World run wrun_4 (unreadable). This release keeps World data in world.db and does not read these runs. To drain them, start the earlier Cloving release with the same state, let each run finish or drop it with "cloving drop <run-id>", stop that service, then start this release again. The finished runs stay in the folder.`,
      });
    },
  ));
