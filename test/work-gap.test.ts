import assert from "node:assert/strict";
import { test } from "node:test";
import type { Fields } from "../src/protocol.ts";
import { atGap, workInProgress, type WorkReads } from "../src/work-gap.ts";

function paged(
  pages: Readonly<Record<string, Fields>>,
  flags: { readonly openTurn: boolean; readonly pendingSubmission: boolean },
): WorkReads {
  return {
    runPage: (after) => {
      const page = pages[after];
      assert.ok(page, `no page after ${after}`);
      return Promise.resolve(page);
    },
    openTurn: () => Promise.resolve(flags.openTurn),
    pendingSubmission: () => Promise.resolve(flags.pendingSubmission),
  };
}

const quiet = { openTurn: false, pendingSubmission: false };

await test("CLV-306 a run of a workflow outside the queue that has not ended is work in progress", async () => {
  const work = await workInProgress(
    paged(
      {
        "": {
          runs: [
            { workflowId: "develop", state: "completed" },
            { workflowId: "review-corpus", state: "running" },
          ],
          next: "run-b",
        },
        "run-b": {
          runs: [
            { workflowId: "develop-prd", state: "waiting" },
            { workflowId: "develop", state: "failed" },
            { workflowId: "develop", state: "cancelled" },
          ],
          next: null,
        },
      },
      quiet,
    ),
  );
  assert.deepEqual(work, {
    activeRuns: 2,
    openTurn: false,
    pendingSubmission: false,
  });
  assert.equal(atGap(work), false);
});

await test("CLV-306 a gap needs no active run, no open turn journal and no pending queue submission", async () => {
  const ended = {
    "": { runs: [{ workflowId: "develop", state: "completed" }], next: null },
  };
  assert.equal(atGap(await workInProgress(paged(ended, quiet))), true);
  assert.equal(
    atGap(
      await workInProgress(
        paged(ended, { openTurn: true, pendingSubmission: false }),
      ),
    ),
    false,
  );
  assert.equal(
    atGap(
      await workInProgress(
        paged(ended, { openTurn: false, pendingSubmission: true }),
      ),
    ),
    false,
  );
});

await test("CLV-306 the gap reader refuses a run list that it cannot read", async () => {
  for (const [page, code] of [
    [{ runs: "none", next: null }, "invalid-run-list"],
    [{ runs: ["running"], next: null }, "invalid-run-status"],
    [{ runs: [], next: "" }, "invalid-run-page"],
    [{ runs: [], next: 7 }, "invalid-run-page"],
  ] as const)
    await assert.rejects(
      workInProgress(paged({ "": page }, quiet)),
      new Error(code),
    );
});
