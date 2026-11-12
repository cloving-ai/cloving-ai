import assert from "node:assert/strict";
import { test } from "node:test";
import { rendered as statusText } from "../src/cli/render.ts";
import { component } from "../src/cli/watch-element.ts";
import { Page } from "../src/cli/watch-view.ts";
import { rendered } from "./watch-dom.ts";
import { played } from "./watch-browser.ts";
import { floorModel } from "./watch-floor-fixture.ts";
import { at, noCopy } from "./watch-sample.ts";

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
  const model = { ...floorModel([], { workflows: ["develop"] }), queue };
  const html = rendered(
    component(Page, {
      model,
      selected: "",
      now: at("21:34:41"),
      stale: false,
      copying: noCopy,
    }),
  );
  assert.match(html, /queue-draining/);
  assert.match(html, /2 of 2 lanes busy/);
  const result = played(
    model,
    `
location.hash = "";
replies.push(JSON.parse(process.env.WATCH_MODEL));
await load();
console.log(JSON.stringify({ html: app.inner }));
`,
  );
  assert.match(String(result["html"]), /queue-draining/);
  assert.match(String(result["html"]), /2 of 2 lanes busy/);
});

const held = {
  ...queue,
  state: "running",
  busy: 0,
  drain: null,
  hold: {
    reason: "load",
    loadPerCore: 0.92,
    limit: 0.7,
    text: "Held: load 0.92 for each core, limit 0.70",
  },
};

await test("CLV-309 cloving status shows the reason of a queue hold", () => {
  const text = statusText({
    kind: "run-list",
    workflows: ["develop"],
    queue: held,
    runs: [],
  });
  assert.match(
    text,
    /Queue: running, 0 of 2 lanes busy\nHeld: load 0\.92 for each core, limit 0\.70/,
  );
  assert.doesNotMatch(
    statusText({ kind: "run-list", workflows: [], queue, runs: [] }),
    /Held:/,
  );
});

await test("CLV-309 the queue line of the watch page shows the reason of a hold in both renders", () => {
  const line = /held: load 0\.92 for each core, limit 0\.70/;
  const model = { ...floorModel([], { workflows: ["develop"] }), queue: held };
  const html = rendered(
    component(Page, {
      model,
      selected: "",
      now: at("21:34:41"),
      stale: false,
      copying: noCopy,
    }),
  );
  assert.match(html, line);
  const result = played(
    model,
    `
location.hash = "";
replies.push(JSON.parse(process.env.WATCH_MODEL));
await load();
console.log(JSON.stringify({ html: app.inner }));
`,
  );
  assert.match(String(result["html"]), line);
});
