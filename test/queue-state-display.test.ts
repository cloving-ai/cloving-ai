import assert from "node:assert/strict";
import { test } from "node:test";
import { rendered as statusText } from "../src/cli/render.ts";
import { component } from "../src/cli/watch-element.ts";
import { Page } from "../src/cli/watch-view.ts";
import { rendered } from "./watch-dom.ts";
import { played } from "./watch-browser.ts";
import { at, noCopy, sampleModel } from "./watch-sample.ts";

const queue = {
  workflowId: "develop",
  lanes: 2,
  busy: 2,
  skipped: [],
  state: "draining",
  stop: null,
  failedRunIds: [],
  drain: { startedAt: Date.parse("2026-11-03T10:00:00.000Z"), drainedAt: null },
};

const headline = /Queue: draining, 2 of 2 lanes busy/;

await test("CLV-273 cloving status shows the queue state and the drain start", () => {
  const text = statusText({
    kind: "run-list",
    workflows: ["develop"],
    queue,
    runs: [],
  });
  assert.match(text, headline);
  assert.match(text, /Drain started: 2026-11-03T10:00:00.000Z/);
});

await test("CLV-273 the watch page shows the queue state in both renders", () => {
  const model = { ...sampleModel([]), queue };
  const html = rendered(
    component(Page, {
      model,
      selected: "",
      now: at("21:34:41"),
      stale: false,
      copying: noCopy,
    }),
  );
  assert.match(html, headline);
  const result = played(
    model,
    `
location.hash = "";
replies.push(JSON.parse(process.env.WATCH_MODEL));
await load();
console.log(JSON.stringify({ html: app.inner }));
`,
  );
  assert.match(String(result["html"]), headline);
});
