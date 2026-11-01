import type { WatchCard } from "../src/cli/watch-render.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { component } from "../src/cli/watch-element.ts";
import { Board, Card } from "../src/cli/watch-board-view.ts";
import { Page, Run } from "../src/cli/watch-view.ts";
import { watchReader } from "../src/cli/watch-reads.ts";
import { result, failed } from "../src/service/replies.ts";
import { boardModel, boardTime } from "./watch-board-fixture.ts";
import { rendered } from "./watch-dom.ts";
import { noCopy } from "./watch-sample.ts";
import { withHarness, field } from "./service-fixture.ts";
import { activeSchedule, scheduleModel } from "./watch-schedule-fixture.ts";

await test("CLV-247 the watch model attaches schedules only to their workflow and marks only scheduled runs", () => {
  const model = scheduleModel();
  const [workflow, other] = model.workflows;
  assert.deepEqual(field(workflow, "schedule"), activeSchedule);
  assert.equal(field(other, "schedule"), undefined);
  for (const run of model.runs) {
    const mark = run.runId === "scheduled-run" ? { slot: 12 } : undefined;
    assert.deepEqual(field(run, "scheduled"), mark);
    const card = workflow?.columns
      .flatMap((column) => column.cards)
      .find((candidate) => candidate.runId === run.runId);
    assert.deepEqual(field(card, "scheduled"), mark);
  }
});

await test("CLV-247 watch boards display schedule state, local times and consecutive failures", () => {
  for (const state of ["active", "paused", "stopped"] as const) {
    const schedule = {
      ...activeSchedule,
      state,
      failuresInRow: state === "stopped" ? 3 : 0,
      nextAt: state === "active" ? activeSchedule.nextAt : null,
      stoppedAt: state === "stopped" ? Date.parse(boardTime) : null,
    };
    const model = scheduleModel(schedule);
    const [workflow, other] = model.workflows;
    assert.ok(workflow && other);
    const html = rendered(component(Board, { workflow, now: boardTime }));
    const times = {
      active: `, next run at ${new Date(schedule.nextAt ?? 0).toLocaleString()}`,
      paused: "",
      stopped: `, stopped at ${new Date(boardTime).toLocaleString()}`,
    };
    const time = times[state];
    assert.ok(
      html.includes(
        `Schedule review-queue: every 300 s, ${state}${time}, ${String(schedule.failuresInRow)} failures in a row`,
      ),
      html,
    );
    assert.doesNotMatch(
      rendered(component(Board, { workflow: other, now: boardTime })),
      /Schedule review-queue/,
    );
    assert.equal(html.includes("next run at"), state === "active");
    for (const run of model.runs) {
      const card: WatchCard | undefined = workflow.columns
        .flatMap((column) => column.cards)
        .find((candidate) => candidate.runId === run.runId);
      assert.ok(card);
      for (const output of [
        rendered(
          component(Card, {
            card,
            workflowId: workflow.workflowId,
            now: boardTime,
          }),
        ),
        rendered(component(Run, { run, now: boardTime, copying: noCopy })),
      ])
        assert.equal(
          output.includes("scheduled 12"),
          run.runId === "scheduled-run",
          output,
        );
    }
  }
});

await test("CLV-247 watch polls retain schedule changes even without a new run event", () =>
  withHarness(async (harness) => {
    let schedules: unknown = [activeSchedule];
    await harness.start({
      schedule: () =>
        Promise.resolve(
          schedules === null
            ? failed("schedules-unavailable", {})
            : result("schedules", { schedules }),
        ),
    });
    const reader = watchReader(harness.runtimeDirectory);
    for (schedules of [
      [activeSchedule],
      [{ ...activeSchedule, state: "paused", nextAt: null }],
      null,
    ]) {
      const read = await reader.read(boardTime);
      assert.deepEqual(
        field(read, "schedules"),
        schedules ?? { status: "unavailable" },
      );
    }
  }));

await test("CLV-247 watch displays scheduler unavailability and preserves absent schedules", () => {
  const model = boardModel([], {
    workflows: ["review-queue"],
    schedules: { status: "unavailable" },
  });
  const html = rendered(
    component(Page, {
      model,
      selected: "workflow=review-queue",
      now: boardTime,
      stale: false,
      copying: noCopy,
    }),
  );
  assert.match(html, /Schedules: unavailable/);
  assert.equal(field(boardModel([]), "schedules"), undefined);
});

await test("CLV-247 watch reads discard malformed schedules before projection", () =>
  withHarness(async (harness) => {
    const malformed = [
      null,
      false,
      "schedule",
      {},
      { ...activeSchedule, workflowId: 42 },
      { ...activeSchedule, everySeconds: "300" },
      { ...activeSchedule, failuresInRow: "0" },
      { ...activeSchedule, state: "unknown" },
    ];
    await harness.start({
      schedule: () =>
        Promise.resolve(result("schedules", { schedules: malformed })),
    });
    const read = await watchReader(harness.runtimeDirectory).read(boardTime);
    assert.deepEqual(read.schedules, []);
    const model = boardModel(read.runs, read);
    assert.deepEqual(field(model, "schedules"), []);
  }));

await test("CLV-247 schedule displays ignore malformed run marks", () => {
  for (const scheduled of [
    null,
    {},
    { slot: "12" },
    { slot: -1 },
    { slot: 1.5 },
    { slot: 9007199254740992 },
  ]) {
    const output = boardModel([
      {
        status: { runId: "bad-mark", workflowId: "review-queue", scheduled },
        events: [],
      },
    ]);
    assert.equal(field(output.runs[0], "scheduled"), undefined);
  }
});

await test("CLV-247 watch reads normalize schedule dates before projection", () =>
  withHarness(async (harness) => {
    const invalid = {
      ...activeSchedule,
      nextAt: 8640000000000001,
      stoppedAt: "bad-date",
    };
    await harness.start({
      schedule: () =>
        Promise.resolve(result("schedules", { schedules: [invalid] })),
    });
    const read = await watchReader(harness.runtimeDirectory).read(boardTime);
    assert.deepEqual(read.schedules, [
      { ...activeSchedule, nextAt: null, stoppedAt: null },
    ]);
    const model = boardModel(read.runs, {
      ...read,
      workflows: ["review-queue"],
    });
    const [workflow] = model.workflows;
    assert.ok(workflow);
    assert.deepEqual(field(workflow, "schedule"), {
      ...activeSchedule,
      nextAt: null,
      stoppedAt: null,
    });
    assert.doesNotMatch(
      rendered(component(Board, { workflow, now: boardTime })),
      /next run at|stopped at|Invalid Date/,
    );
  }));

await test("CLV-247 paused schedules suppress next times", () => {
  const [paused] = scheduleModel({
    ...activeSchedule,
    state: "paused",
  }).workflows;
  assert.ok(paused);
  assert.doesNotMatch(
    rendered(component(Board, { workflow: paused, now: boardTime })),
    /next run at/,
  );
});
