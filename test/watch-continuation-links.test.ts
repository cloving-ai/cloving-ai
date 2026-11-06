import assert from "node:assert/strict";
import { test } from "node:test";
import { boardModel, boardRun } from "./watch-board-fixture.ts";
import { Card } from "../src/cli/watch-board-view.ts";
import { found, rendered } from "./watch-dom.ts";
import { fields } from "./service-fixture.ts";

await test("CLV-307 a watch card links the run that it continues and the run that continues it", () => {
  const run = boardRun("middle");
  const model = boardModel([
    {
      ...run,
      status: {
        ...fields(run["status"]),
        continuedFrom: "run-old",
        continuedBy: "run-new",
      },
    },
  ]);
  const [shownRun] = model.runs;
  assert.ok(shownRun);
  assert.equal(shownRun.continuedFrom, "run-old");
  assert.equal(shownRun.continuedBy, "run-new");
  const card = model.workflows.flatMap((workflow) =>
    workflow.columns.flatMap((column) => column.cards),
  )[0];
  assert.ok(card);
  const shown = Card({
    card,
    workflowId: "develop-issue",
    now: model.updatedAt,
  });
  const hrefs = found(shown, "a").map((link) => link["href"]);
  assert.ok(hrefs.includes("#run=run-old"));
  assert.ok(hrefs.includes("#run=run-new"));
  const html = rendered(shown);
  assert.match(html, /Continues: run-old/);
  assert.match(html, /Continued by: run-new/);
});
