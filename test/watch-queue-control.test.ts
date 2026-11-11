import assert from "node:assert/strict";
import { test } from "node:test";
import { component } from "../src/cli/watch-element.ts";
import type { WatchModel } from "../src/cli/watch-render.ts";
import { Page, type QueueControls } from "../src/cli/watch-view.ts";
import { played } from "./watch-browser.ts";
import { found, rendered } from "./watch-dom.ts";
import { floorModel, floorRun } from "./watch-floor-fixture.ts";
import { noCopy } from "./watch-sample.ts";

const controls: QueueControls = {
  busy: false,
  message: "",
  onCommand: () => undefined,
};

function shown(model: WatchModel, queue?: QueueControls) {
  return component(Page, {
    model,
    selected: "",
    now: model.updatedAt,
    stale: false,
    copying: noCopy,
    ...(queue === undefined ? {} : { queue }),
  });
}

function queued(
  state?: string,
  runs: readonly Record<string, unknown>[] = [],
): WatchModel {
  return floorModel(runs, {
    queue: {
      busy: 0,
      lanes: 2,
      skipped: [],
      ...(state === undefined ? {} : { state }),
    },
  });
}

function control(model: WatchModel, queue?: QueueControls) {
  return found(shown(model, queue), "button").find(
    (button) => button["class"] === "queue-control",
  );
}

await test("CLV-286 the header shows a queue control that drains a running queue and resumes a stopped one", () => {
  const html = rendered(shown(queued("running"), controls));
  assert.match(
    html,
    /<div class="header-actions"><button type="button" class="queue-control">Drain queue<\/button><\/div><\/header>/,
  );
  for (const state of ["draining", "drained", "stopped"])
    assert.equal(
      control(queued(state), controls)?.["children"],
      "Resume queue",
    );
  assert.equal(
    control(queued("running"), { ...controls, busy: true })?.["disabled"],
    true,
  );
  assert.match(
    rendered(
      shown(queued("running"), { ...controls, message: "Refresh the page." }),
    ),
    /<span class="queue-message">Refresh the page\.<\/span>/,
  );
  assert.equal(control(queued("running")), undefined);
  assert.equal(control(queued(), controls), undefined);
});

await test("CLV-286 the run detail of a token keeps the queue control and its message in the header", () => {
  const model = queued("running", [
    floorRun("pr-583", { operation: "github-merge", ticketId: "583" }),
  ]);
  const html = rendered(
    component(Page, {
      model,
      selected: "run=pr-583",
      now: model.updatedAt,
      stale: false,
      copying: noCopy,
      queue: { ...controls, message: "Refresh the page." },
    }),
  );
  assert.match(html, /<section class="banner working">[\s\S]*pr-583/);
  assert.match(
    html,
    /<div class="header-actions"><button type="button" class="queue-control">Drain queue<\/button><span class="queue-message">Refresh the page\.<\/span><\/div><\/header>/,
  );
});

await test("CLV-286 the queue control posts its command with the page token and loads the page data again", () => {
  const model = { ...queued("running"), cardForms: [] };
  const result = played(
    model,
    `
const model = JSON.parse(process.env.WATCH_MODEL);
const posts = [];
const plain = globalThis.fetch;
globalThis.fetch = (address, options) => {
  if (options?.method === "POST") posts.push({ address, ...options });
  return plain(address, options);
};
location.hash = "";
replies.push(model);
await load();
const button = app.all("button").find((node) => node.inner === "Drain queue");
if (!button) throw new Error("missing queue control");
replies.push({ command: "drain", replayed: false }, { ...model, queue: { ...model.queue, state: "draining" } });
button.dispatch("click");
for (let turn = 0; turn < 5; turn++) await settled();
console.log(JSON.stringify({ posts, requests, html: app.inner }));
`,
  );
  assert.deepEqual(result["posts"], [
    {
      address: "actions/queue",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cloving-token": "a".repeat(64),
      },
      body: '{"command":"drain"}',
    },
  ]);
  assert.deepEqual(result["requests"], [
    "phone.json",
    "data.json",
    "actions/queue",
    "data.json",
  ]);
  assert.match(String(result["html"]), />Resume queue<\/button>/);
});

await test("CLV-358 the page script shows a pending restart in the header and still renders the page", () => {
  const model = floorModel([], { restart: { activeRuns: 4 } });
  const result = played(
    model,
    `
location.hash = "";
replies.push(JSON.parse(process.env.WATCH_MODEL));
await load();
console.log(JSON.stringify({ html: app.inner }));
`,
  );
  const html = String(result["html"]);
  assert.match(html, /Restart pending: 4 runs active/);
  assert.match(html, /Floor/);
});
