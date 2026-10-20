import assert from "node:assert/strict";
import { test } from "node:test";
import { watchReader } from "../src/cli/watch-reads.ts";
import { fields } from "./service-fixture.ts";
import {
  boardModel,
  boardRun,
  boardTime,
  sampleStages,
  stagedModel,
  stageEvent,
} from "./watch-board-fixture.ts";
import {
  watchData,
  watchReplies,
  withWatchService,
} from "./watch-service-fixture.ts";

await test("CLV-128 the watch server carries stage metadata for an empty board", async () => {
  const { answer } = watchReplies({
    runs: [],
    workflows: ["sample"],
    workflowStages: { sample: sampleStages },
  });
  await withWatchService(answer, async (watch) => {
    const model = await watchData(watch.address);
    assert.deepEqual(
      model["workflows"],
      stagedModel([], { runs: [] }).workflows,
    );
  });
});

await test("CLV-128 paginated committed history and fresh reader rebuild match the full pure projection", async () => {
  const events = Array.from({ length: 1003 }, (_, index) => ({
    sequence: index * 2 + 1,
    recordedAt: boardTime,
    type: "effect.reported",
    payload: {},
  }));
  const starts = new Map([
    [
      2001,
      { ...stageEvent(2001, { gateKind: "approval" }), recordedAt: boardTime },
    ],
    [
      2003,
      {
        ...stageEvent(2003, { operation: "write-draft" }),
        recordedAt: "2026-10-14T01:00:00Z",
      },
    ],
  ]);
  const history = events.map((event) => starts.get(event.sequence) ?? event);
  const status = {
    ...fields(boardRun("sample-run", { workflowId: "sample" })["status"]),
    latestSequence: 2005,
  };
  const { requests, answer } = watchReplies({
    runs: [status],
    events: history,
    workflows: ["sample"],
    workflowStages: { sample: sampleStages },
  });
  await withWatchService(answer, async (watch, runtimeDirectory) => {
    const expected = stagedModel(history, { summaries: [status] }).workflows;
    for (let rebuild = 0; rebuild < 2; rebuild += 1) {
      const reader = watchReader(runtimeDirectory);
      const read = await reader.read(boardTime);
      assert.deepEqual(
        boardModel(read.runs, { ...read, updatedAt: boardTime }).workflows,
        expected,
      );
      assert.equal(read.runs[0]?.events.length, 1003);
      assert.deepEqual(await reader.read(boardTime), read);
    }
    const pages = requests.filter(
      (request) =>
        request.operation === "events" &&
        request.parameters["runId"] === "sample-run",
    );
    assert.ok(pages.some((request) => request.parameters["after"] === 1999));
    assert.ok(pages.every((request) => request.parameters["limit"] === 1000));
    const served = await watchData(watch.address);
    assert.deepEqual(served["workflows"], expected);
  });
});

await test("CLV-128 absent or malformed service stage metadata keeps the legacy fallback", async () => {
  for (const workflowStages of [
    undefined,
    null,
    [],
    1,
    { sample: [] },
    { sample: [{ name: "x", label: "Other", operations: ["x"] }] },
  ]) {
    const { answer } = watchReplies({
      runs: [],
      workflows: ["sample"],
      workflowStages,
    });
    await withWatchService(answer, async (watch) => {
      const model = await watchData(watch.address);
      assert.deepEqual(
        model["workflows"],
        boardModel([], { workflows: ["sample"] }).workflows,
      );
    });
  }
});
