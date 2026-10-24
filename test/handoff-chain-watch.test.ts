import assert from "node:assert/strict";
import { test } from "node:test";
import { boardModel, boardRun } from "./watch-board-fixture.ts";
import { Card } from "../src/cli/watch-board-view.ts";
import { found, rendered } from "./watch-dom.ts";
import { admitted, fields, withHarness } from "./service-fixture.ts";
import { played } from "./watch-browser.ts";
import { watchReader } from "../src/cli/watch-reads.ts";
import { operationOf } from "./effect-fixture.ts";

for (const view of ["board", "run"]) {
  await test(`CLV-183 cached ${view} watch links refresh after child admission with no parent event`, () =>
    withHarness(async (harness) => {
      await harness.start();
      const parent = await admitted(harness, `watch-${view}-parent`);
      const reader = watchReader(harness.runtimeDirectory);
      const read = () =>
        view === "board"
          ? reader.read(new Date().toISOString())
          : reader.run(parent);
      const before = (await read()).runs.find(
        (run) => run.status.runId === parent,
      );
      assert.ok(before);
      assert.deepEqual(before.status["childRunIds"], []);
      const child = await admitted(
        harness,
        `handoff:${operationOf(parent, { round: 1 })}`,
      );
      const after = (await read()).runs.find(
        (run) => run.status.runId === parent,
      );
      assert.ok(after);
      assert.equal(after.status.latestSequence, before.status.latestSequence);
      assert.deepEqual(after.events, before.events);
      assert.deepEqual(after.status["childRunIds"], [child]);
      const model = boardModel([after]);
      assert.deepEqual(model.runs[0]?.childRunIds, [child]);
    }));
}

await test("CLV-183 watch runs and cards retain chain links across workflows with encoded navigation", () => {
  const parent = "earlier /&<parent>";
  const child = "later /&<child>";
  const run = boardRun("middle");
  const model = boardModel([
    {
      ...run,
      status: {
        ...fields(run["status"]),
        parentRunId: parent,
        chainId: "root",
        childRunIds: [child],
      },
    },
  ]);
  const middle = model.runs[0];
  assert.ok(middle);
  assert.equal(Reflect.get(middle, "parentRunId"), parent);
  assert.equal(Reflect.get(middle, "chainId"), "root");
  assert.deepEqual(Reflect.get(middle, "childRunIds"), [child]);
  const card = model.workflows.flatMap((workflow) =>
    workflow.columns.flatMap((column) => column.cards),
  )[0];
  assert.ok(card);
  const shown = Card({
    card,
    workflowId: "develop-issue",
    now: model.updatedAt,
  });
  const links = found(shown, "a");
  for (const runId of [parent, child])
    assert.ok(
      links.some(
        (link) => link["href"] === `#run=${encodeURIComponent(runId)}`,
      ),
    );
  const html = rendered(shown);
  assert.match(html, /Parent run: earlier \/&amp;&lt;parent&gt;/);
  assert.match(html, /Child run: later \/&amp;&lt;child&gt;/);
});

await test("CLV-183 the watch browser bundle renders parent and child navigation on cards", () => {
  const run = boardRun("middle");
  const model = boardModel([
    {
      ...run,
      status: {
        ...fields(run["status"]),
        parentRunId: "earlier",
        chainId: "earlier",
        childRunIds: ["later"],
      },
    },
  ]);
  const result = played(
    model,
    `
location.hash = "#workflow=develop-issue";
replies.push(JSON.parse(process.env.WATCH_MODEL));
await load();
console.log(JSON.stringify({ html: app.inner }));
`,
  );
  const html = String(fields(result)["html"]);
  assert.match(html, /href="#run=earlier"/);
  assert.match(html, /href="#run=later"/);
  assert.match(html, /Parent run: earlier/);
  assert.match(html, /Child run: later/);
});
