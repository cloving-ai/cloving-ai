import assert from "node:assert/strict";
import { test } from "node:test";
import { component } from "../src/cli/watch-element.ts";
import { pageDocument } from "../src/cli/watch-page.ts";
import { Page } from "../src/cli/watch-view.ts";
import { boardModel, boardRun } from "./watch-board-fixture.ts";
import { found, rendered } from "./watch-dom.ts";
import { noCopy } from "./watch-sample.ts";
import { played } from "./watch-browser.ts";

await test("CLV-228 project workflows with former bundled IDs show no old agent prompt", () => {
  for (const workflowId of [
    "develop-issue",
    "develop-ticket",
    "develop-prd",
    "develop-prompt",
    "custom-workflow",
  ]) {
    const model = boardModel([], { workflows: [workflowId] });
    const shown = component(Page, {
      model,
      selected: `workflow=${workflowId}`,
      now: model.updatedAt,
      stale: false,
      copying: noCopy,
    });
    const html = rendered(shown);
    assert.ok(html.includes(workflowId));
    assert.doesNotMatch(
      html,
      /Agent prompt|Copy the prompt|Start a run|Start a Cloving run/,
    );
    assert.equal(found(shown, "article").length, 0);
  }
});

await test("CLV-228 the served watch page ships no bundled agent prompts", () => {
  assert.doesNotMatch(
    pageDocument(),
    /Start a Cloving run|ISSUE_NUMBER|TICKET_ID|cloving run develop-/,
  );
});

await test("CLV-228 saved start-prompt preferences cannot restore the retired prompts", () => {
  const result = played(
    boardModel([], { workflows: ["develop-issue"] }),
    `
const reads = [];
globalThis.localStorage = { getItem: (key) => { reads.push(key); return "true"; }, setItem() { throw new Error("unexpected write"); } };
location.hash = "#workflow=develop-issue";
replies.push(JSON.parse(process.env.WATCH_MODEL));
await load();
console.log(JSON.stringify({ html: app.inner, reads, requests, streams: sources.map((source) => source.address) }));
`,
  );
  assert.doesNotMatch(String(result["html"]), /Start a run|Copy the prompt/);
  assert.deepEqual(result["reads"], ["cloving.watch.columns:develop-issue"]);
  assert.deepEqual(result["requests"], ["data.json"]);
  assert.deepEqual(result["streams"], ["events"]);
});

await test("CLV-228 removing bundled prompts preserves the run detail page", () => {
  const model = boardModel([boardRun("run-1")]);
  const shown = component(Page, {
    model,
    selected: "workflow=develop-issue&run=run-1",
    now: model.updatedAt,
    stale: false,
    copying: noCopy,
  });
  assert.doesNotMatch(rendered(shown), /Start a run|Copy the prompt/);
  assert.match(rendered(shown), /class="banner working"/);
});
