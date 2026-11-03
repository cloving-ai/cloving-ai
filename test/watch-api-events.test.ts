import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { watchApiDocument } from "../src/cli/watch-api-document.ts";
import { fields, waitingGate, withHarness } from "./service-fixture.ts";
import { contractBody } from "./watch-api-contract.ts";
import {
  detailRecords,
  detailReplies,
  foreignRequest,
  newEvents,
  streamReader,
} from "./watch-api-fixture.ts";
import { watching } from "./watch-fixture.ts";
import { withWatchService } from "./watch-service-fixture.ts";

const eventsPath = "/runs/{runId}/events";

async function eventsAfter(address: string, query: string): Promise<unknown> {
  const response = await fetch(`${address}api/v1/runs/run-new/events${query}`);
  assert.equal(response.status, 200, query);
  return fields(
    await contractBody(watchApiDocument, { response, path: eventsPath }),
  )["events"];
}

function shownEvents(after: number): readonly unknown[] {
  return newEvents
    .filter((event) => Number(event["sequence"]) > after)
    .map((event) => ({
      sequence: event["sequence"],
      type: event["type"],
      recordedAt: event["recordedAt"],
    }));
}

await test("CLV-255 GET api/v1/runs/{runId}/events gives the events with a sequence above after, the lowest sequence first, with no payload", () =>
  withWatchService(
    { answer: detailReplies().answer, configure: detailRecords },
    async (watch) => {
      const all = await eventsAfter(watch.address, "?after=0");
      assert.deepEqual(all, shownEvents(0));
      assert.deepEqual(
        shownEvents(0).map((event) => fields(event)["sequence"]),
        [1, 2, 3, 4],
      );
      assert.deepEqual(await eventsAfter(watch.address, ""), all);
      assert.deepEqual(await eventsAfter(watch.address, "?after=2"), [
        ...shownEvents(2),
      ]);
      assert.deepEqual(
        shownEvents(2).map((event) => fields(event)["type"]),
        ["step.completed", "run.paused"],
      );
      assert.deepEqual(await eventsAfter(watch.address, "?after=4"), []);
    },
  ));

function changeTime(message: string): string {
  const data = /^event: change\ndata: (.+)\n\n$/.exec(message)?.[1];
  assert.ok(data !== undefined, message);
  const change = fields(JSON.parse(data));
  assert.deepEqual(Object.keys(change), ["updatedAt"]);
  const time = String(change["updatedAt"]);
  assert.equal(new Date(time).toISOString(), time);
  return time;
}

await test("CLV-255 GET api/v1/stream sends event: change with an updatedAt time at the connection and for a change of a run, and refuses a foreign Host header with 403", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const watch = await watching(harness.runtimeDirectory);
    try {
      assert.equal(await foreignRequest(watch.address, "api/v1/stream"), 403);
      const before = new Date().toISOString();
      const stream = streamReader(watchApiDocument, {
        response: await fetch(`${watch.address}api/v1/stream`),
        path: "/stream",
      });
      const connected = changeTime(await stream.next());
      assert.ok(connected >= before);
      await delay(300);
      const next = stream.next();
      await waitingGate(harness, {
        service,
        commandId: "c-255",
        kind: "approval",
      });
      assert.ok(changeTime(await next) >= connected);
      await stream.cancel();
    } finally {
      assert.equal(await watch.stop(), 0);
    }
    await service.close();
  }));

await test("CLV-255 an unknown run gives a 404 problem with the code not-found on both run paths", () =>
  withWatchService(
    { answer: detailReplies().answer, configure: detailRecords },
    async (watch) => {
      for (const [served, path] of [
        ["/runs/unknown", "/runs/{runId}"],
        ["/runs/unknown/events", eventsPath],
        ["/runs/unknown/events?after=2", eventsPath],
      ] as const) {
        const response = await fetch(`${watch.address}api/v1${served}`);
        assert.equal(response.status, 404, served);
        assert.deepEqual(
          await contractBody(watchApiDocument, { response, path }),
          {
            type: "about:blank",
            title: "Not Found",
            status: 404,
            detail: "The service has no run with this ID.",
            code: "not-found",
          },
        );
      }
    },
  ));

await test("CLV-255 an invalid after or an unknown parameter on a run path or the stream gives a 400 problem with the code invalid-query", () =>
  withWatchService(
    { answer: detailReplies().answer, configure: detailRecords },
    async (watch) => {
      for (const [served, path, name] of [
        ["/runs/run-new/events?after=-1", eventsPath, "after"],
        ["/runs/run-new/events?after=x", eventsPath, "after"],
        ["/runs/run-new/events?after=1.5", eventsPath, "after"],
        ["/runs/run-new/events?after=01", eventsPath, "after"],
        ["/runs/run-new/events?after=", eventsPath, "after"],
        ["/runs/run-new/events?after=1&after=2", eventsPath, "after"],
        ["/runs/run-new/events?limit=2", eventsPath, "limit"],
        ["/runs/run-new?after=1", "/runs/{runId}", "after"],
        ["/runs/unknown?verbose=1", "/runs/{runId}", "verbose"],
        ["/stream?since=1", "/stream", "since"],
      ] as const) {
        const response = await fetch(`${watch.address}api/v1${served}`);
        assert.equal(response.status, 400, served);
        assert.deepEqual(
          await contractBody(watchApiDocument, { response, path }),
          {
            type: "about:blank",
            title: "Bad Request",
            status: 400,
            detail: `The query parameter ${name} is unknown, repeated or has an invalid value.`,
            code: "invalid-query",
          },
          served,
        );
      }
    },
  ));
