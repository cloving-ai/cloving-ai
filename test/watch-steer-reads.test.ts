import assert from "node:assert/strict";
import { test } from "node:test";
import { watchReader } from "../src/cli/watch-reads.ts";
import { watchReplies, withWatchService } from "./watch-service-fixture.ts";

const turn = JSON.stringify([
  "cloving-operation",
  1,
  "run-a",
  "implement",
  "claude-turn",
]);

await test("CLV-327 the watch reads a run again while a note waits, because a turn that gets a note now adds no event", async () => {
  const note = {
    noteId: "note-a",
    text: "Change only src/cli.ts.",
    source: "steer",
    recordedAt: "2026-11-08T10:00:00.000Z",
    receivedBy: null as string | null,
  };
  const run = {
    runId: "run-a",
    workflowId: "develop",
    state: "running",
    latestSequence: 4,
    latestAt: "2026-11-08T10:00:00.000Z",
    notes: [note],
  };
  const replies = watchReplies({ runs: [run], workflows: ["develop"] });
  await withWatchService(replies.answer, async (_watch, runtime) => {
    const reader = watchReader(runtime);
    const reads = () =>
      replies.requests.filter(
        (request) =>
          request.operation === "status" &&
          request.parameters["runId"] === "run-a",
      ).length;
    const shown = async () =>
      (await reader.read("2026-11-08T10:01:00.000Z")).runs[0]?.status["notes"];
    await shown();
    const first = reads();
    note.receivedBy = turn;
    assert.deepEqual(await shown(), [{ ...note }]);
    assert.equal(reads(), first + 1);
    await shown();
    assert.equal(reads(), first + 1);
  });
});
