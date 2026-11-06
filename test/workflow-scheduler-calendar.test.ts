import assert from "node:assert/strict";
import { test } from "node:test";
import type { ServiceRequest } from "../src/protocol.ts";
import type { DeclaredWorkflow } from "../src/workflow-declaration.ts";
import {
  reached,
  scheduledWorkflow,
  withScheduler,
} from "./workflow-scheduler-fixture.ts";

const calendar = {
  at: "07:00",
  timeZone: "America/Los_Angeles",
  input: { prompt: "current" },
};
const daily: DeclaredWorkflow = { ...scheduledWorkflow, schedule: calendar };
const mondays: DeclaredWorkflow = {
  ...scheduledWorkflow,
  schedule: { ...calendar, weekdays: ["monday"] },
};
const active = {
  state: "active",
  failuresInRow: 0,
  failedRunIds: [],
};

async function savedReview(scene: {
  readonly saved: () => Promise<string>;
}): Promise<unknown> {
  const saved: unknown = JSON.parse(await scene.saved());
  assert.ok(saved !== null && typeof saved === "object" && "review" in saved);
  return saved.review;
}

function runs(scene: { readonly requests: readonly ServiceRequest[] }): number {
  return scene.requests.filter((request) => request.operation === "run").length;
}

async function settled(scene: {
  readonly requests: readonly ServiceRequest[];
  readonly saved: () => Promise<string>;
}): Promise<void> {
  await reached(
    async () =>
      runs(scene) === 1 && !(await scene.saved()).includes('"pending"'),
  );
}

async function idle(scene: { readonly ticks: () => number }): Promise<void> {
  const ticks = scene.ticks();
  await reached(() => scene.ticks() > ticks + 3);
}

await test("CLV-314 a daily schedule runs at the local time and then the next day", () =>
  withScheduler(
    { declarations: [daily], start: Date.parse("2026-11-10T06:00:00-08:00") },
    async (scene) => {
      assert.deepEqual(await savedReview(scene), {
        lastSlot: 0,
        ...active,
        at: "07:00",
        timeZone: "America/Los_Angeles",
        nextAt: Date.parse("2026-11-10T07:00:00-08:00"),
      });
      scene.now(Date.parse("2026-11-10T06:59:59-08:00"));
      await idle(scene);
      assert.equal(scene.requests.length, 0);
      scene.now(Date.parse("2026-11-10T07:00:00-08:00"));
      await settled(scene);
      assert.equal(
        scene.requests[0]?.parameters["commandId"],
        "schedule:review:1",
      );
      const review = await savedReview(scene);
      assert.ok(review !== null && typeof review === "object");
      assert.ok("nextAt" in review && "lastSlot" in review);
      assert.equal(review.nextAt, Date.parse("2026-11-11T07:00:00-08:00"));
      assert.equal(review.lastSlot, 1);
    },
  ));

await test("CLV-314 a weekday schedule does not run on other days", () =>
  withScheduler(
    { declarations: [mondays], start: Date.parse("2026-11-10T06:00:00-08:00") },
    async (scene) => {
      scene.now(Date.parse("2026-11-10T07:00:00-08:00"));
      await idle(scene);
      assert.equal(scene.requests.length, 0);
      scene.now(Date.parse("2026-11-16T07:00:00-08:00"));
      await settled(scene);
      const review = await savedReview(scene);
      assert.ok(review !== null && typeof review === "object");
      assert.ok("nextAt" in review);
      assert.equal(review.nextAt, Date.parse("2026-11-23T07:00:00-08:00"));
    },
  ));

await test("CLV-314 a daemon down for three daily slots submits one run at its start", () =>
  withScheduler(
    {
      declarations: [daily],
      start: Date.parse("2026-11-13T08:00:00-08:00"),
      initial: {
        review: {
          at: "07:00",
          timeZone: "America/Los_Angeles",
          nextAt: Date.parse("2026-11-10T07:00:00-08:00"),
          lastSlot: 0,
        },
      },
    },
    async (scene) => {
      await settled(scene);
      await idle(scene);
      assert.equal(runs(scene), 1);
      const review = await savedReview(scene);
      assert.ok(review !== null && typeof review === "object");
      assert.ok("nextAt" in review && "lastSlot" in review);
      assert.equal(review.nextAt, Date.parse("2026-11-14T07:00:00-08:00"));
      assert.equal(review.lastSlot, 1);
    },
  ));

await test("CLV-314 a changed time, zone or day list computes a new slot and keeps the slot count", async () => {
  const start = Date.parse("2026-11-10T06:00:00-08:00");
  for (const prior of [
    { everySeconds: 300 },
    { at: "08:00", timeZone: "America/Los_Angeles" },
    { at: "07:00", timeZone: "UTC" },
    { at: "07:00", timeZone: "America/Los_Angeles", weekdays: ["monday"] },
  ])
    await withScheduler(
      {
        declarations: [daily],
        start,
        initial: { review: { ...prior, nextAt: start + 1000, lastSlot: 4 } },
      },
      async (scene) => {
        assert.deepEqual(await savedReview(scene), {
          lastSlot: 4,
          ...active,
          at: "07:00",
          timeZone: "America/Los_Angeles",
          nextAt: Date.parse("2026-11-10T07:00:00-08:00"),
        });
      },
    );
  await withScheduler(
    {
      start,
      initial: {
        review: {
          at: "07:00",
          timeZone: "UTC",
          weekdays: ["monday"],
          nextAt: start + 1000,
          lastSlot: 4,
        },
      },
    },
    async (scene) => {
      assert.deepEqual(await savedReview(scene), {
        lastSlot: 4,
        ...active,
        everySeconds: 300,
        nextAt: start + 300000,
      });
    },
  );
});

await test("CLV-314 the list shows calendar fields and the next run with its offset; resume moves to the next named day", () =>
  withScheduler(
    { declarations: [mondays], start: Date.parse("2026-11-10T06:00:00-08:00") },
    async (scene) => {
      const listed = async (): Promise<unknown> => {
        const list = await scene.control({ action: "list" });
        assert.equal(list.kind, "result");
        const schedules = list.result["schedules"];
        assert.ok(Array.isArray(schedules));
        return schedules[0];
      };
      const summary = {
        workflowId: "review",
        at: "07:00",
        timeZone: "America/Los_Angeles",
        weekdays: ["monday"],
        state: "active",
        failuresInRow: 0,
        failedRunIds: [],
        lastSlot: 0,
        nextAt: Date.parse("2026-11-16T07:00:00-08:00"),
        nextLocal: "2026-11-16T07:00:00-08:00",
        activeRunId: null,
        stoppedAt: null,
        stoppedSlot: null,
        stops: [],
      };
      assert.deepEqual(await listed(), summary);
      await scene.control({ action: "pause", workflowId: "review" });
      assert.deepEqual(await listed(), {
        ...summary,
        state: "paused",
        nextAt: null,
        nextLocal: null,
      });
      scene.now(Date.parse("2026-11-17T08:00:00-08:00"));
      await scene.control({ action: "resume", workflowId: "review" });
      assert.deepEqual(await listed(), {
        ...summary,
        nextAt: Date.parse("2026-11-23T07:00:00-08:00"),
        nextLocal: "2026-11-23T07:00:00-08:00",
      });
    },
  ));
