import assert from "node:assert/strict";
import { test } from "node:test";
import { watchApiDocument } from "../src/cli/watch-api-document.ts";
import { contractBody } from "./watch-api-contract.ts";
import { fields } from "./service-fixture.ts";
import { expectedLoops, loopReplies } from "./watch-loops-fixture.ts";
import { watchData, withWatchService } from "./watch-service-fixture.ts";

await test("CLV-328 GET api/v1/schedules gives one row for each loop with its rule, state, next run, last run and failures, the same rows as the page", () =>
  withWatchService(loopReplies().answer, async (watch) => {
    const response = await fetch(`${watch.address}api/v1/schedules`);
    assert.equal(response.status, 200);
    assert.deepEqual(
      await contractBody(watchApiDocument, { response, path: "/schedules" }),
      { schedules: expectedLoops },
    );
    assert.deepEqual((await watchData(watch.address))["loops"], expectedLoops);
  }));

await test("CLV-328 a loop with no run of the loop has no last run, and a service with no loops gives an empty list", async () => {
  const replies = loopReplies([
    {
      workflowId: "nightly",
      everySeconds: 45,
      state: "paused",
      failuresInRow: 0,
      nextAt: null,
      stoppedAt: null,
    },
  ]);
  await withWatchService(replies.answer, async (watch) => {
    const response = await fetch(`${watch.address}api/v1/schedules`);
    assert.deepEqual(await response.json(), {
      schedules: [
        {
          workflowId: "nightly",
          rule: "every 45 s",
          state: "paused",
          nextAt: null,
          failuresInRow: 0,
          lastRun: null,
        },
      ],
    });
  });
  await withWatchService(loopReplies([]).answer, async (watch) => {
    const response = await fetch(`${watch.address}api/v1/schedules`);
    assert.deepEqual(await response.json(), { schedules: [] });
  });
});

await test("CLV-328 GET api/v1/schedules answers 503 when the service does not answer", () =>
  withWatchService(
    () => ({ kind: "error", error: { code: "down", detail: "Down." } }),
    async (watch) => {
      const response = await fetch(`${watch.address}api/v1/schedules`);
      assert.equal(response.status, 503);
      await contractBody(watchApiDocument, { response, path: "/schedules" });
    },
  ));

await test("CLV-328 GET api/v1/schedules answers 503 with schedules-unavailable when the service answers but its scheduler does not", () =>
  withWatchService(
    loopReplies({ status: "unavailable" }).answer,
    async (watch) => {
      const response = await fetch(`${watch.address}api/v1/schedules`);
      assert.equal(response.status, 503);
      const body = await contractBody(watchApiDocument, {
        response,
        path: "/schedules",
      });
      assert.equal(fields(body)["code"], "schedules-unavailable");
    },
  ));
