import assert from "node:assert/strict";
import { test } from "node:test";
import { watchReader } from "../src/cli/watch-reads.ts";
import { fields, items } from "./service-fixture.ts";
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

await test("CLV-228 former bundled IDs honor declared stages for empty boards and event histories", () => {
  for (const workflowId of [
    "develop-issue",
    "develop-ticket",
    "develop-prd",
    "develop-prompt",
  ]) {
    const events = [
      stageEvent(1, { operation: "write-draft" }),
      stageEvent(2, { gateId: "team-review", gateKind: "approval" }),
      stageEvent(3, { operation: "write-draft" }),
      stageEvent(4, { operation: "unmatched" }),
    ];
    for (let count = 0; count <= events.length; count += 1) {
      const model = boardModel(
        count === 0
          ? []
          : [
              boardRun("project-run", {
                workflowId,
                events: events.slice(0, count).toReversed(),
              }),
            ],
        {
          workflows: [workflowId],
          workflowStages: { [workflowId]: [sampleStages[0], ...reviewStages] },
        },
      );
      const board = model.workflows[0];
      assert.deepEqual(
        board?.columns.map((column) => column.name),
        [
          "Draft",
          "Your review",
          "Team review",
          "Ready to merge",
          "Other",
          "Done",
          "Stopped",
        ],
      );
      const cards = board.columns.flatMap((column) => column.cards);
      assert.equal(cards.length, count === 0 ? 0 : 1);
      assert.deepEqual(
        cards[0]?.currentStep ?? null,
        count === 0
          ? null
          : {
              name: ["Draft", "Team review", "Draft", "Other"][count - 1],
              startedAt: events[count - 1]?.recordedAt,
            },
      );
    }
  }
});

await test("CLV-263 archived detail retains declared phases for a former bundled ID", async () => {
  const workflowId = "develop-issue";
  const { answer } = watchReplies({
    runs: [
      {
        runId: "archived",
        workflowId,
        state: "completed",
        latestSequence: 1,
        latestAt: "2020-01-01T00:00:00Z",
      },
    ],
    workflows: [workflowId],
    workflowStages: { [workflowId]: sampleStages },
    events: [stageEvent(1, { operation: "write-draft" })],
  });
  await withWatchService(answer, async (watch) => {
    const response = await fetch(`${watch.address}data.json?runId=archived`);
    assert.equal(response.status, 200);
    const model = fields(await response.json());
    assert.deepEqual(
      items(fields(model["run"])["phases"]).map(
        (phase) => fields(phase)["name"],
      ),
      ["Admitted", "Started", "Draft", "Review", "Completed"],
    );
  });
});
