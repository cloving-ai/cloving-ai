import assert from "node:assert/strict";
import { test } from "node:test";
import { fields, items } from "./service-fixture.ts";
import {
  attentionMark,
  completionReplies,
  laterMark,
  stoppedMark,
} from "./watch-completion-fixture.ts";
import {
  watchData,
  watchReplies,
  withWatchService,
} from "./watch-service-fixture.ts";

await test("CLV-091 watch searches later status pages and paginated evidence outside Done limits and retention", async () => {
  const recent = new Date().toISOString();
  for (const latestAt of [
    recent,
    "2020-01-01T00:00:00Z",
    "2099-01-01T00:00:00Z",
    "invalid",
    null,
  ]) {
    const { answer, requests } = completionReplies(latestAt);
    await withWatchService(answer, async (watch) => {
      const model = await watchData(watch.address);
      assert.deepEqual(stoppedMark(model), laterMark);
      const board = fields(items(model["workflows"])[0]);
      const done = items(board["columns"])
        .map(fields)
        .find((column) => column["name"] === "Done");
      assert.equal(items(done?.["cards"]).length, 20);
      assert.ok(
        !items(done?.["cards"]).some(
          (card) => fields(card)["runId"] === "zz-later",
        ),
      );
      assert.equal(
        items(model["runs"]).some((run) => fields(run)["runId"] === "zz-later"),
        latestAt === recent,
      );
      for (const runId of ["a-stopped", "zz-later"])
        assert.ok(
          requests.some(
            (request) =>
              request.operation === "events" &&
              request.parameters["runId"] === runId &&
              request.parameters["after"] === 1000,
          ),
        );
      assert.ok(
        requests.every((request) =>
          ["status", "events", "questions"].includes(request.operation),
        ),
      );
    });
  }
});

await test("CLV-091 each board read recomputes completion when only the later run changes", async () => {
  const { answer, requests, runs } = completionReplies();
  const index = runs.findIndex((run) => run["runId"] === "zz-later");
  const completed = runs[index];
  assert.ok(completed);
  runs[index] = {
    ...completed,
    state: "running",
    outcome: null,
    latestSequence: 1000,
  };
  await withWatchService(answer, async (watch) => {
    assert.deepEqual(
      stoppedMark(await watchData(watch.address)),
      attentionMark,
    );
    const reads = requests.filter(
      (request) => request.parameters["runId"] === "a-stopped",
    ).length;
    runs[index] = completed;
    assert.deepEqual(stoppedMark(await watchData(watch.address)), laterMark);
    assert.equal(
      requests.filter((request) => request.parameters["runId"] === "a-stopped")
        .length,
      reads,
    );
  });
});

await test("CLV-077 watch reads both run pages and every active run, including the second page", async () => {
  const runs = Array.from({ length: 51 }, (_, index) => ({
    runId: `run-${String(index).padStart(3, "0")}`,
    workflowId: "develop-issue",
    state: "running",
    latestSequence: 1,
    latestAt: "2020-01-01T00:00:00Z",
  }));
  const { requests, answer } = watchReplies({ runs });
  await withWatchService(answer, async (watch) => {
    const model = await watchData(watch.address);
    assert.equal(items(model["runs"]).length, 51);
    assert.ok(
      requests.some(
        (request) =>
          request.operation === "status" &&
          request.parameters["after"] === "run-049",
      ),
    );
    assert.ok(
      requests.some(
        (request) =>
          request.operation === "events" &&
          request.parameters["runId"] === "run-050",
      ),
    );
  });
});

await test("CLV-077 watch excludes old ended runs from board reads but serves a requested older run", async () => {
  const runs = [
    {
      runId: "old",
      workflowId: "develop-ticket",
      state: "completed",
      latestAt: "2020-01-01T00:00:00Z",
      latestSequence: 1,
      title: "Older work",
      outcome: { kind: "handoff_requested" },
    },
    {
      runId: "recent",
      workflowId: "develop-issue",
      state: "completed",
      latestAt: new Date().toISOString(),
      latestSequence: 2,
    },
  ];
  const { requests, answer } = watchReplies({ runs });
  await withWatchService(answer, async (watch) => {
    const model = await watchData(watch.address);
    assert.equal(items(model["runs"]).length, 1);
    assert.ok(
      !requests.some((request) => request.parameters["runId"] === "old"),
    );
    const older = await fetch(`${watch.address}data.json?runId=old`);
    assert.equal(older.status, 200);
    const data: unknown = await older.json();
    const run = fields(fields(data)["run"]);
    assert.equal(run["runId"], "old");
    assert.equal(run["title"], "Older work");
    assert.ok(
      requests.some(
        (request) =>
          request.operation === "events" &&
          request.parameters["runId"] === "old",
      ),
    );
  });
});

await test("CLV-077 watch follows event sequences beyond a thousand events to the newest round", async () => {
  const operationId = JSON.stringify([
    "cloving-operation",
    2,
    "long",
    "implement",
    "claude-turn",
  ]);
  const events = Array.from({ length: 1001 }, (_, index) => ({
    sequence: index * 2 + 1,
    recordedAt: `2026-10-14T${index === 1000 ? "11" : "10"}:00:00Z`,
    type: index === 1000 ? "effect.requested" : "run.started",
    payload: { operationId },
  }));
  const run = {
    runId: "long",
    workflowId: "develop-issue",
    state: "running",
    latestSequence: 2001,
  };
  const { requests, answer } = watchReplies({ runs: [run], events });
  await withWatchService(answer, async (watch) => {
    const model = await watchData(watch.address);
    const shown = fields(items(model["runs"])[0]);
    assert.equal(items(shown["events"]).length, 1001);
    assert.deepEqual(shown["currentStep"], {
      name: "Claude turn",
      startedAt: "2026-10-14T11:00:00Z",
    });
    assert.ok(
      requests.some(
        (request) =>
          request.operation === "events" &&
          request.parameters["after"] === 1999,
      ),
    );
  });
});
