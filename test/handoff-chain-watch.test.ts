import assert from "node:assert/strict";
import { test } from "node:test";
import { boardModel, boardRun } from "./watch-board-fixture.ts";
import { Card } from "../src/cli/watch-board-view.ts";
import { found, rendered } from "./watch-dom.ts";
import { fields } from "./service-fixture.ts";
import { played } from "./watch-browser.ts";

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
