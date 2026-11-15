import assert from "node:assert/strict";
import { test } from "node:test";
import { QueueCard } from "../src/cli/watch-queue-card-view.ts";
import { component } from "../src/cli/watch-element.ts";
import { found, rendered } from "./watch-dom.ts";
import { played } from "./watch-browser.ts";
import { floorModel } from "./watch-floor-fixture.ts";

const queue = {
  workflowId: "develop-issue",
  state: "running",
  lanes: 2,
  busy: 3,
  settings: { workingLanes: { value: 2, source: "default" } },
};
const model = { ...floorModel([]), queues: [queue], cardForms: [] };

await test("CLV-377 capacity, occupancy and effective working cap stay separate above a lowered limit", () => {
  const shown = component(QueueCard, { queue });
  assert.match(rendered(shown), /aria-label="Lanes limit">2/);
  assert.match(rendered(shown), /aria-label="Active work cap limit">2/);
  assert.match(rendered(shown), /3 of 2 lanes busy/);
  const advanced = found(shown, "details");
  assert.equal(advanced.length, 1);
  assert.equal(advanced[0]?.["open"], undefined);
  assert.match(rendered(shown), /Advanced.*Waiting for CI or a person/);
  assert.equal(
    found(shown, "span").filter((item) => item["class"] === "lane busy").length,
    3,
  );
});

await test("CLV-377 rapid lane clicks keep one pending request and show saving, applying and exact applied feedback", () => {
  const result = played(
    model,
    `
location.hash = "";
const model = JSON.parse(process.env.WATCH_MODEL);
replies.push(model);
await load();
const messages = [];
const drawPage = draw;
draw = () => { messages.push(state.queueMessages["develop-issue"]); drawPage(); };
const posts = [];
let answer;
const plain = globalThis.fetch;
globalThis.fetch = (address, options) => {
  if (options?.method === "POST") {
    posts.push(JSON.parse(options.body));
    return new Promise((resolve) => { answer = resolve; });
  }
  return plain(address, options);
};
const pending = queuePost("develop-issue", { command: "lanes", lanes: 1, expectedLanes: 2 });
await queuePost("develop-issue", { command: "lanes", lanes: 3, expectedLanes: 2 });
const applied = { ...model.queues[0], lanes: 1, settings: { workingLanes: { value: 1, source: "queues setting (private file)" } } };
replies.push({ ...model, queues: [applied] });
answer({ ok: true, status: 200, json: async () => ({ queue: applied }) });
await pending;
console.log(JSON.stringify({ messages, posts, message: state.queueMessages["develop-issue"] }));
`,
  );
  assert.equal(Array.isArray(result["posts"]) && result["posts"].length, 1);
  const messages = String(result["messages"]);
  assert.match(messages, /Saving/);
  assert.match(messages, /Applying/);
  assert.match(
    String(result["message"]),
    /Applied: 1 lane.*cap adjusted.*Advanced/,
  );
});

await test("CLV-377 a mismatched or missing effective reply cannot show applied", () => {
  for (const effective of [
    {},
    { queue: { ...queue, lanes: 4 } },
    { queue: { ...queue, workflowId: "other", lanes: 3 } },
  ]) {
    const result = played(
      model,
      `
location.hash = "";
const model = JSON.parse(process.env.WATCH_MODEL);
replies.push(model);
await load();
replies.push(${JSON.stringify(effective)}, model);
await queuePost("develop-issue", { command: "lanes", lanes: 3, expectedLanes: 2 });
console.log(JSON.stringify({ message: state.queueMessages["develop-issue"] }));
`,
    );
    assert.match(String(result["message"]), /not confirmed.*Refresh/);
    assert.doesNotMatch(String(result["message"]), /Applied:/);
  }
});

await test("CLV-377 a delayed apply reply cannot claim success over a newer effective read", () => {
  const result = played(
    model,
    `
location.hash = "";
const model = JSON.parse(process.env.WATCH_MODEL);
replies.push(model);
await load();
const applied = { ...model.queues[0], lanes: 3 };
const newer = { ...model, queues: [{ ...applied, lanes: 4 }] };
replies.push({ queue: applied }, newer);
await queuePost("develop-issue", { command: "lanes", lanes: 3, expectedLanes: 2 });
console.log(JSON.stringify({ message: state.queueMessages["develop-issue"], lanes: state.model.queues[0].lanes }));
`,
  );
  assert.equal(result["lanes"], 4);
  assert.match(String(result["message"]), /not confirmed.*Refresh/);
});

await test("CLV-377 a lost fresh read cannot reuse a prior matching snapshot as proof of apply", () => {
  const result = played(
    model,
    `
location.hash = "";
const model = JSON.parse(process.env.WATCH_MODEL);
replies.push(model);
await load();
replies.push({ queue: model.queues[0] });
await queuePost("develop-issue", { command: "lanes", lanes: 2, expectedLanes: 2 });
console.log(JSON.stringify({ message: state.queueMessages["develop-issue"] }));
`,
  );
  assert.match(String(result["message"]), /not confirmed.*Refresh/);
});
