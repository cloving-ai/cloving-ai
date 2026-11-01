import assert from "node:assert/strict";
import { test } from "node:test";
import { watchReader } from "../src/cli/watch-reads.ts";
import { completionReplies } from "./watch-completion-fixture.ts";
import {
  mergeRepository,
  mergedJournal,
  writeMergeRecords,
} from "./watch-merge-fixture.ts";
import { configuredPrWatch } from "./watch-pr-cli-fixture.ts";
import {
  stoppedMark,
  laterMark,
  attentionMark,
} from "./watch-completion-fixture.ts";
import { withWatchService, watchData } from "./watch-service-fixture.ts";

await test("CLV-129 candidate discovery uses established issue identity rather than ticket IDs", async () => {
  const replies = completionReplies();
  const later = replies.runs.at(-1);
  assert.ok(later);
  replies.runs[replies.runs.length - 1] = {
    ...later,
    ticketId: "different-ticket-id",
  };
  await withWatchService(replies.answer, async (_watch, runtime) => {
    const read = await watchReader(runtime, mergeRepository).read(
      new Date().toISOString(),
    );
    assert.equal(read.completionCandidates[0]?.status.runId, "zz-later");
  });
});

await test("CLV-129 the board recomputes when only an older successor's merge journal completes", async () => {
  const replies = completionReplies();
  const records = mergedJournal("zz-later");
  const merge = records[1];
  assert.ok(merge);
  await withWatchService(
    {
      answer: replies.answer,
      configure: async (runtime) => {
        await writeMergeRecords(runtime, [
          records[0] ?? merge,
          { ...merge, result: null },
        ]);
        return configuredPrWatch(runtime);
      },
    },
    async (watch, runtime) => {
      assert.deepEqual(
        stoppedMark(await watchData(watch.address)),
        attentionMark,
      );
      const before = replies.requests.filter(
        (request) => request.parameters["runId"] === "a-stopped",
      );
      await writeMergeRecords(runtime, records);
      assert.deepEqual(stoppedMark(await watchData(watch.address)), laterMark);
      assert.deepEqual(
        replies.requests.filter(
          (request) => request.parameters["runId"] === "a-stopped",
        ),
        before,
      );
    },
  );
});

await test("CLV-129 missing or conflicting issue identity prevents older candidate event reads", async () => {
  for (const issueIdentity of [
    null,
    {},
    { owner: "other", repository: "demo", number: 7 },
    { owner: "fixture", repository: "demo", number: 8 },
    { owner: "fixture", repository: "demo", number: 0 },
  ]) {
    const replies = completionReplies();
    const later = replies.runs.at(-1);
    assert.ok(later);
    replies.runs[replies.runs.length - 1] = { ...later, issueIdentity };
    await withWatchService(replies.answer, async (_watch, runtime) => {
      const read = await watchReader(runtime, mergeRepository).read(
        new Date().toISOString(),
      );
      assert.deepEqual(read.completionCandidates, []);
      assert.ok(
        !replies.requests.some(
          (request) =>
            request.operation === "events" &&
            request.parameters["runId"] === "zz-later",
        ),
      );
    });
  }
});

await test("CLV-263 each workflow retains completion evidence for its visible stopped cards", async () => {
  const replies = completionReplies();
  const stopped = replies.runs[0];
  const later = replies.runs.at(-1);
  assert.ok(stopped && later);
  replies.runs.splice(
    1,
    replies.runs.length - 2,
    ...Array.from({ length: 20 }, (_, index) => ({
      ...stopped,
      runId: `other-${String(index)}`,
      workflowId: "other",
      state: "failed",
      latestAt: new Date(Date.now() + 1000).toISOString(),
    })),
  );
  await withWatchService(replies.answer, async (_watch, runtime) => {
    const read = await watchReader(runtime, mergeRepository).read(
      new Date(Date.now() + 2000).toISOString(),
    );
    assert.equal(read.completionCandidates[0]?.status.runId, later["runId"]);
  });
});
