import assert from "node:assert/strict";
import { test } from "node:test";
import { fields, items } from "./service-fixture.ts";
import {
  interruptedCompletionReplies,
  laterMark,
  stoppedMark,
  withCompletionService,
} from "./watch-completion-fixture.ts";
import {
  interruptedReplies,
  longEvents,
  longRun,
  repeatedEvents,
  repeatedPage,
  watchData,
  watchReplies,
  withWatchService,
} from "./watch-service-fixture.ts";

await test("CLV-091 a failed first status read preserves the empty service-down model", async () => {
  const { answer } = interruptedReplies({ operation: "status", runs: [] });
  await withWatchService(answer, async (watch) => {
    const model = await watchData(watch.address);
    assert.equal(model["service"], "down");
    assert.deepEqual(model["runs"], []);
    assert.deepEqual(model["workflows"], []);
  });
});

const completionFailures = [
  { operation: "status", runId: undefined, after: "done-48" },
  { operation: "status", runId: "zz-later", after: undefined },
  { operation: "events", runId: "zz-later", after: 0 },
  { operation: "events", runId: "zz-later", after: 1 },
];
for (const failure of completionFailures)
  await test(`CLV-091 required search failure ${JSON.stringify(failure)} returns failed and retries complete evidence`, async () => {
    const replies = interruptedCompletionReplies(failure);
    await withCompletionService(replies.answer, async (watch) => {
      const failed = await fetch(`${watch.address}data.json`);
      assert.equal(failed.status, 500, JSON.stringify(failure));
      assert.equal(await failed.text(), "failed");
      assert.deepEqual(stoppedMark(await watchData(watch.address)), laterMark);
      const reads = replies.requests.filter(
        (request) =>
          request.operation === "events" &&
          request.parameters["runId"] === "zz-later",
      );
      assert.equal(
        reads.filter((request) => request.parameters["after"] === 0).length,
        failure.operation === "events" ? 2 : 1,
      );
      await watchData(watch.address);
      assert.equal(
        replies.requests.filter(
          (request) =>
            request.operation === "events" &&
            request.parameters["runId"] === "zz-later",
        ).length,
        reads.length,
      );
    });
  });

await test("CLV-077 an interrupted event page gives an error and retry reads the complete history before caching it", async () => {
  const { answer, requests } = interruptedReplies({
    operation: "events",
    after: 1000,
    runs: [longRun],
    events: longEvents,
  });
  await withWatchService(answer, async (watch) => {
    assert.equal((await fetch(`${watch.address}data.json`)).status, 500);
    const model = await watchData(watch.address);
    assert.equal(items(fields(items(model["runs"])[0])["events"]).length, 1001);
    const reads = requests.filter(
      (request) => request.operation === "events",
    ).length;
    await watchData(watch.address);
    const response = await fetch(`${watch.address}data.json?runId=long`);
    assert.equal(response.status, 200);
    const data: unknown = await response.json();
    assert.equal(items(fields(fields(data)["run"])["events"]).length, 1001);
    assert.equal(
      requests.filter((request) => request.operation === "events").length,
      reads,
    );
  });
});

await test("CLV-077 an interrupted run page gives an error instead of a partial board and can be retried", async () => {
  const runs = Array.from({ length: 51 }, (_, index) => ({
    ...longRun,
    runId: `run-${String(index).padStart(3, "0")}`,
  }));
  const { answer } = interruptedReplies({
    operation: "status",
    after: "run-049",
    runs,
  });
  await withWatchService(answer, async (watch) => {
    assert.equal((await fetch(`${watch.address}data.json`)).status, 500);
    assert.equal(items((await watchData(watch.address))["runs"]).length, 51);
  });
});

await test("CLV-077 an unknown requested run gives 404 and a failed requested read gives 500", async () => {
  const { answer } = interruptedReplies({
    operation: "status",
    runs: [longRun],
  });
  await withWatchService(answer, async (watch) => {
    assert.equal(
      (await fetch(`${watch.address}data.json?runId=long`)).status,
      500,
    );
    assert.equal(
      (await fetch(`${watch.address}data.json?runId=missing`)).status,
      404,
    );
    assert.equal(
      (await fetch(`${watch.address}data.json?runId=long`)).status,
      200,
    );
  });
});

await test("CLV-077 repeated run and event cursors fail without looping", async () => {
  await withWatchService(repeatedPage, async (watch) => {
    assert.equal((await fetch(`${watch.address}data.json`)).status, 500);
  });
  await withWatchService(repeatedEvents, async (watch) => {
    assert.equal((await fetch(`${watch.address}data.json`)).status, 500);
  });
});

await test("CLV-077 a full final event page ends at an empty page and a null end time is not recent", async () => {
  const runs = [
    longRun,
    { ...longRun, runId: "unknown-time", state: "completed", latestAt: null },
  ];
  const { answer, requests } = watchReplies({
    runs,
    events: longEvents.slice(0, 1000),
  });
  await withWatchService(answer, async (watch) => {
    const model = await watchData(watch.address);
    assert.equal(items(model["runs"]).length, 1);
    assert.equal(items(fields(items(model["runs"])[0])["events"]).length, 1000);
    assert.ok(
      requests.some(
        (request) =>
          request.operation === "events" &&
          request.parameters["after"] === 1000,
      ),
    );
  });
});

await test("CLV-077 watch rejects run identifiers and sequences with the wrong types before caching a run", async () => {
  for (const changed of [{ runId: 12 }, { latestSequence: "1001" }]) {
    const { answer } = watchReplies({ runs: [{ ...longRun, ...changed }] });
    await withWatchService(answer, async (watch) => {
      assert.equal((await fetch(`${watch.address}data.json`)).status, 500);
      const runId = String(changed.runId ?? longRun.runId);
      assert.equal(
        (await fetch(`${watch.address}data.json?runId=${runId}`)).status,
        changed.runId === undefined ? 500 : 404,
      );
    });
  }
});

await test("CLV-077 watch rejects an event with a nonnumeric sequence even on a short page", async () => {
  const { answer } = watchReplies({
    runs: [longRun],
    events: [{ sequence: "1", type: "run.started" }],
  });
  await withWatchService(answer, async (watch) => {
    assert.equal((await fetch(`${watch.address}data.json`)).status, 500);
  });
});
