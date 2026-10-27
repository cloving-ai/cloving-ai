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
  reviewStages,
  paginatedReviewHistory,
  stageEvent,
} from "./watch-board-fixture.ts";
import {
  watchData,
  watchReplies,
  withWatchService,
} from "./watch-service-fixture.ts";

await test("CLV-234 ID-only metadata and successive gates agree in the reader, projection and data.json", async () => {
  for (let count = 0; count <= reviewStages.length; count += 1) {
    const history = reviewStages.slice(0, count).map((stage, index) =>
      stageEvent(index + 1, {
        gateId: stage.gateIds[0],
        gateKind: "approval",
      }),
    );
    const status = {
      ...fields(boardRun("sample-run", { workflowId: "sample" })["status"]),
      latestSequence: count,
    };
    const workflowStages = { sample: reviewStages };
    const { answer } = watchReplies({
      runs: count === 0 ? [] : [status],
      events: history,
      workflows: ["sample"],
      workflowStages,
    });
    await withWatchService(answer, async (watch, runtimeDirectory) => {
      const read = await watchReader(runtimeDirectory).read(boardTime);
      assert.deepEqual(read.workflowStages, workflowStages);
      const expected = stagedModel(history, {
        workflowStages,
        runs: read.runs,
        summaries: read.summaries,
      }).workflows;
      assert.deepEqual((await watchData(watch.address))["workflows"], expected);
      const cards = expected.flatMap((board) =>
        board.columns.flatMap((column) => column.cards),
      );
      assert.deepEqual(
        cards.map((card) => card.currentStep),
        history.slice(-1).map((event) => ({
          name: reviewStages[count - 1]?.label,
          startedAt: event.recordedAt,
        })),
      );
    });
  }
});

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
  const history = paginatedReviewHistory();
  const status = {
    ...fields(boardRun("sample-run", { workflowId: "sample" })["status"]),
    latestSequence: 2005,
  };
  const { requests, answer } = watchReplies({
    runs: [status],
    events: history,
    workflows: ["sample"],
    workflowStages: { sample: reviewStages },
  });
  await withWatchService(answer, async (watch, runtimeDirectory) => {
    const expected = stagedModel(history, {
      summaries: [status],
      workflowStages: { sample: reviewStages },
    }).workflows;
    assert.deepEqual(expected[0]?.columns[1]?.cards[0]?.currentStep, {
      name: "Team review",
      startedAt: "2026-10-14T01:00:00Z",
    });
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

await test("CLV-234 invalid ID metadata discards only the affected workflow's stages", async () => {
  for (const gateIds of [[""], ["team-review", "team-review"], null]) {
    const { answer } = watchReplies({
      runs: [],
      workflows: ["sample", "invalid"],
      workflowStages: {
        sample: reviewStages,
        invalid: [
          {
            name: "invalid",
            label: "Invalid",
            operations: ["write-draft"],
            gateIds,
          },
        ],
      },
    });
    await withWatchService(answer, async (watch, runtimeDirectory) => {
      const read = await watchReader(runtimeDirectory).read(boardTime);
      assert.deepEqual(read.workflowStages, { sample: reviewStages });
      assert.deepEqual(
        (await watchData(watch.address))["workflows"],
        boardModel([], {
          workflows: ["sample", "invalid"],
          workflowStages: { sample: reviewStages },
        }).workflows,
      );
    });
  }
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
