import assert from "node:assert/strict";
import { test } from "node:test";
import { watchReader } from "../src/cli/watch-reads.ts";
import { Card } from "../src/cli/watch-board-view.ts";
import { Run } from "../src/cli/watch-view.ts";
import { component } from "../src/cli/watch-element.ts";
import { boardModel } from "./watch-board-fixture.ts";
import { commandWaitHost } from "./command-wait-host-fixture.ts";
import { eventually, field, items, withHarness } from "./service-fixture.ts";
import { rendered } from "./watch-dom.ts";
import { played } from "./watch-browser.ts";
import {
  readWaitStatus,
  shownWait,
  waitModel,
} from "./command-wait-display-fixture.ts";
import { noCopy } from "./watch-sample.ts";

await test("CLV-238 watch details and summaries carry wait times through quiet polls beyond one week", () =>
  withHarness(async (harness) => {
    const scene = await commandWaitHost(harness);
    await scene.ordinary(1);
    await scene.ports.commandWait.open(scene.opening);
    const reader = watchReader(harness.runtimeDirectory);
    const sequences: unknown[] = [];
    for (const days of [8, 9]) {
      scene.clock.now += (days === 8 ? 8 : 1) * 86_400_000;
      const now = new Date(scene.clock.now).toISOString();
      const read = await reader.read(now);
      assert.equal(read.runs.length, 1);
      const expected = await readWaitStatus(harness, scene.runId);
      const waits = field(expected, "commandWaits");
      assert.deepEqual(read.runs[0]?.status["commandWaits"], waits);
      assert.deepEqual(read.summaries[0]?.["commandWaits"], waits);
      assert.deepEqual(
        (await reader.run(scene.runId)).runs[0]?.status["commandWaits"],
        waits,
      );
      const model = boardModel(read.runs, { ...read, updatedAt: now });
      assert.deepEqual(field(model.runs[0], "commandWaits"), waits);
      const board = model.workflows[0];
      assert.ok(board);
      assert.equal(board.waitingCount, 1);
      assert.equal(board.activeCount, 1);
      const withoutSummaries = boardModel(read.runs, {
        workflows: read.workflows,
        updatedAt: now,
      });
      assert.equal(withoutSummaries.workflows[0]?.waitingCount, 1);
      const card = board.columns.flatMap((column) => column.cards)[0];
      assert.ok(card);
      const remaining = field(items(waits)[0], "remainingSeconds");
      assert.equal(remaining, (30 - days) * 86_400);
      const run = model.runs[0];
      assert.ok(run);
      for (const html of [
        rendered(Card({ card, workflowId: "develop", now })),
        rendered(component(Run, { run, now, copying: noCopy })),
      ]) {
        assert.ok(html.includes(`${String(remaining)} s left`), html);
        assert.ok(
          html.includes(String(field(items(waits)[0], "deadline"))),
          html,
        );
        assert.ok(
          html.includes(String(field(items(waits)[0], "nextCheckAt"))),
          html,
        );
        assert.match(html, /1 of 2 effect units/);
      }
      sequences.push(read.runs[0]?.status.latestSequence);
    }
    assert.equal(sequences[0], sequences[1]);
  }));

await test("CLV-238 ended watch waits keep their time and reason and no longer count as waiting", () =>
  withHarness(async (harness) => {
    const scene = await commandWaitHost(harness);
    await scene.ports.commandWait.open({
      ...scene.opening,
      input: '{"secret":"watch-input-fixture"}',
    });
    scene.clock.now += 123_001;
    scene.clock.output = "watch-stdout-fixture watch-stderr-fixture";
    await scene.ports.commandWait.check({
      ...scene.request,
      commandId: "failure",
    });
    await eventually(async () =>
      (await scene.ports.commandWait.read(scene.request))?.state === "failed"
        ? true
        : undefined,
    );
    const reader = watchReader(harness.runtimeDirectory);
    const snapshots: unknown[] = [];
    for (const advance of [0, 86_400_000]) {
      scene.clock.now += advance;
      const now = new Date(scene.clock.now).toISOString();
      const read = await reader.read(now);
      const model = boardModel(read.runs, { ...read, updatedAt: now });
      const run = model.runs[0];
      assert.ok(run);
      const wait = run.commandWaits?.[0];
      assert.ok(wait);
      assert.equal(wait.remainingSeconds, 2_591_877);
      assert.equal(wait.reason, "command-wait-invalid-output");
      assert.equal(model.workflows[0]?.waitingCount, 0);
      assert.equal(
        boardModel(read.runs, { workflows: read.workflows }).workflows[0]
          ?.waitingCount,
        0,
      );
      snapshots.push(run.commandWaits);
      const card = model.workflows[0].columns.flatMap(
        (column) => column.cards,
      )[0];
      assert.ok(card);
      const html = rendered([
        Card({ card, workflowId: "develop", now }),
        component(Run, { run, now, copying: noCopy }),
      ]);
      assert.match(html, /command-wait-invalid-output/);
      assert.match(html, /2591877 s left/);
      for (const value of [JSON.stringify(model), html])
        assert.doesNotMatch(
          value,
          /watch-input-fixture|watch-stdout-fixture|watch-stderr-fixture|inputDigest|commandOutput/,
        );
    }
    assert.deepEqual(snapshots[0], snapshots[1]);
  }));

await test("CLV-238 watch polls clamp the countdown at zero after the deadline", () =>
  withHarness(async (harness) => {
    const scene = await commandWaitHost(harness);
    await scene.ports.commandWait.open(scene.opening);
    const wait = await scene.ports.commandWait.read(scene.request);
    assert.ok(wait);
    const reader = watchReader(harness.runtimeDirectory);
    for (const [offset, remaining] of [
      [-1, 1],
      [0, 0],
      [1001, 0],
    ] as const) {
      scene.clock.now = wait.deadline + offset;
      const now = new Date(scene.clock.now).toISOString();
      const read = await reader.read(now);
      const model = boardModel(read.runs, { ...read, updatedAt: now });
      const run = model.runs[0];
      assert.ok(run);
      assert.equal(run.commandWaits?.[0]?.remainingSeconds, remaining);
      const board = model.workflows[0];
      assert.ok(board);
      const card = board.columns.flatMap((column) => column.cards)[0];
      assert.ok(card);
      for (const html of [
        rendered(Card({ card, workflowId: "develop", now })),
        rendered(component(Run, { run, now, copying: noCopy })),
      ])
        assert.ok(html.includes(`${String(remaining)} s left`));
    }
    await eventually(async () =>
      (await scene.ports.commandWait.read(scene.request))?.state === "timed-out"
        ? true
        : undefined,
    );
    const read = await reader.read(new Date(scene.clock.now).toISOString());
    const model = boardModel(read.runs, { ...read });
    assert.equal(
      model.runs[0]?.commandWaits?.[0]?.reason,
      "command-wait-timeout",
    );
    assert.equal(model.workflows[0]?.waitingCount, 0);
  }));

await test("CLV-238 serialized browser helpers refresh card and detail times and preserve terminal reasons", () => {
  const model = waitModel();
  assert.deepEqual(model.runs[0]?.commandWaits, [shownWait]);
  const result = played(
    model,
    `
const snapshot = JSON.parse(process.env.WATCH_MODEL);
const screens = [];
for (const [remaining, status, reason] of [[2160000, "waiting", null], [2159999, "waiting", null], [0, "timed-out", "command-wait-timeout"], [0, "timed-out", "command-wait-timeout"]]) {
  for (const run of snapshot.runs) Object.assign(run.commandWaits[0], { remainingSeconds: remaining, state: status, reason });
  for (const workflow of snapshot.workflows)
    for (const column of workflow.columns)
      for (const card of column.cards) Object.assign(card.commandWaits[0], { remainingSeconds: remaining, state: status, reason });
  for (const hash of ["#workflow=review-queue", "#workflow=review-queue&run=run-1"]) {
    location.hash = hash;
    replies.push(JSON.parse(JSON.stringify(snapshot)));
    await load();
    screens.push(app.inner);
  }
}
console.log(JSON.stringify({ screens }));
`,
  );
  const screens = items(result["screens"]);
  assert.equal(screens.length, 8);
  for (const [index, html] of screens.entries()) {
    const remaining = [2_160_000, 2_159_999, 0, 0][Math.floor(index / 2)];
    assert.ok(String(html).includes(`${String(remaining)} s left`));
    assert.ok(String(html).includes(String(shownWait.deadline)));
    assert.ok(String(html).includes(String(shownWait.nextCheckAt)));
    assert.match(String(html), /1 of 2 effect units/);
    assert.equal(String(html).includes("command-wait-timeout"), index >= 4);
    assert.doesNotMatch(
      String(html),
      /browser-(input|stdout|stderr|output)-fixture/,
    );
  }
});
