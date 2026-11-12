import assert from "node:assert/strict";
import { test } from "node:test";
import { component } from "../src/cli/watch-element.ts";
import { Page, type QueueControls } from "../src/cli/watch-view.ts";
import { played } from "./watch-browser.ts";
import { found, rendered } from "./watch-dom.ts";
import { floorModel } from "./watch-floor-fixture.ts";
import { noCopy } from "./watch-sample.ts";

const controls: QueueControls = {
  busy: [],
  messages: {},
  onCommand: () => undefined,
  onLanes: () => undefined,
};

function queued(state = "running", lanes = 2) {
  return {
    ...floorModel([]),
    queues: [
      { workflowId: "develop-issue", state, lanes, busy: 0, skipped: [] },
      { workflowId: "idea", state: "drained", lanes: 1, busy: 0 },
    ],
  };
}

function shown(
  state = "running",
  options: { readonly queue?: QueueControls; readonly lanes?: number } = {},
) {
  const model = queued(state, options.lanes ?? 2);
  return component(Page, {
    model,
    selected: "",
    now: model.updatedAt,
    stale: false,
    copying: noCopy,
    queue: options.queue,
  });
}

function invoke(handler: unknown) {
  assert.ok(typeof handler === "function");
  Reflect.apply(handler, undefined, []);
}

await test("CLV-361 queue cards switch and adjust only their own queue, with lane limits and per-queue feedback", () => {
  const commands: (
    | Parameters<QueueControls["onCommand"]>
    | Parameters<QueueControls["onLanes"]>
  )[] = [];
  const queue: QueueControls = {
    ...controls,
    onCommand: (...args) => {
      commands.push(args);
    },
    onLanes: (...args) => {
      commands.push(args);
    },
  };
  const switches = found(shown("running", { queue }), "input");
  assert.equal(switches.length, 2);
  assert.equal(switches[0]?.["checked"], true);
  assert.equal(switches[1]?.["checked"], false);
  switches.forEach((item) => {
    invoke(item["onChange"]);
  });
  const buttons = found(shown("running", { queue }), "button");
  buttons.slice(0, 2).forEach((item) => {
    invoke(item["onClick"]);
  });
  assert.deepEqual(commands, [
    ["develop-issue", "drain"],
    ["idea", "resume"],
    ["develop-issue", { lanes: 1, expectedLanes: 2 }],
    ["develop-issue", { lanes: 3, expectedLanes: 2 }],
  ]);
  assert.equal(
    found(shown("running", { queue, lanes: 1 }), "button")[0]?.["disabled"],
    true,
  );
  assert.equal(
    found(shown("running", { queue, lanes: 16 }), "button")[1]?.["disabled"],
    true,
  );
  const busy = shown("running", {
    queue: {
      ...queue,
      busy: ["develop-issue"],
      messages: { "develop-issue": "Refresh the page." },
    },
  });
  assert.equal(found(busy, "input")[0]?.["disabled"], true);
  assert.equal(found(busy, "input")[1]?.["disabled"], false);
  assert.match(rendered(busy), /Refresh the page\./);
  assert.equal(found(shown(), "button").length, 0);
  assert.equal(found(shown(), "input").length, 0);
  assert.doesNotMatch(
    rendered(shown("running", { queue })).split("</header>")[0] ?? "",
    /Queue|lanes busy|queue-waiting/,
  );
});

await test("CLV-361 an off queue explains the missing setting or command without unusable controls", () => {
  for (const reason of [
    "state off in the queues setting",
    "no ticket command",
  ]) {
    const model = queued("off");
    const html = rendered(
      component(Page, {
        model: {
          ...model,
          queues: model.queues
            .slice(0, 1)
            .map((queue) => ({ ...queue, off: { reason } })),
        },
        selected: "",
        now: model.updatedAt,
        stale: false,
        copying: noCopy,
        queue: controls,
      }),
    );
    assert.match(html, /Queue off/);
    assert.ok(html.includes(reason));
    assert.doesNotMatch(html, /<button|role="switch"/);
  }
});

for (const scenario of [
  {
    name: "switch",
    first: { command: "drain" },
    second: { command: "resume" },
    next: { command: "drain" },
    after: "drained",
    lanes: 2,
  },
  {
    name: "lanes",
    first: { command: "lanes", lanes: 3, expectedLanes: 2 },
    second: { command: "lanes", lanes: 4, expectedLanes: 3 },
    next: { command: "lanes", lanes: 5, expectedLanes: 4 },
    after: "running",
    lanes: 3,
  },
]) {
  await test(`CLV-361 a lost ${scenario.name} reply cannot override a new click`, () => {
    const result = played(
      { ...queued(), cardForms: [] },
      `
const model = JSON.parse(process.env.WATCH_MODEL);
const scenario = ${JSON.stringify(scenario)};
const posts = [];
const plain = globalThis.fetch;
globalThis.fetch = (address, options) => {
  if (options?.method === "POST") {
    posts.push(JSON.parse(options.body));
    if (posts.length === 1) return Promise.reject(new Error("lost"));
  }
  return plain(address, options);
};
location.hash = "";
replies.push(model);
await load();
const after = { ...model, queues: model.queues.map((queue) => queue.workflowId === "develop-issue" ? { ...queue, state: scenario.after, lanes: scenario.lanes } : queue) };
replies.push(after);
await queuePost("develop-issue", scenario.first);
replies.push({}, model);
await queuePost("develop-issue", scenario.second);
replies.push({}, model);
await queuePost("develop-issue", scenario.next);
console.log(JSON.stringify({ posts }));
`,
    );
    const posts = result["posts"];
    assert.ok(Array.isArray(posts));
    assert.equal(posts.length, 3);
    for (const [index, requested] of [
      scenario.first,
      scenario.second,
      scenario.next,
    ].entries()) {
      const commandId: unknown = Reflect.get(Object(posts[index]), "commandId");
      assert.ok(typeof commandId === "string");
      assert.deepEqual(posts[index], {
        ...requested,
        workflowId: "develop-issue",
        commandId,
      });
    }
    assert.notEqual(
      Reflect.get(Object(posts[0]), "commandId"),
      Reflect.get(Object(posts[2]), "commandId"),
    );
  });
}

await test("CLV-361 a displayed state change expires an unanswered command even when the queue returns to its former state", () => {
  const result = played(
    { ...queued(), cardForms: [] },
    `
const model = JSON.parse(process.env.WATCH_MODEL);
const posts = [];
const plain = globalThis.fetch;
globalThis.fetch = (address, options) => {
  if (options?.method === "POST") {
    posts.push(JSON.parse(options.body));
    return Promise.reject(new Error("lost"));
  }
  return plain(address, options);
};
location.hash = "";
replies.push(model);
await load();
replies.push({ ...model, queues: model.queues.map((queue) => ({ ...queue, state: "drained" })) });
await queuePost("develop-issue", { command: "drain" });
replies.push(model);
await load();
replies.push(model);
await queuePost("develop-issue", { command: "drain" });
console.log(JSON.stringify({ posts }));
`,
  );
  const posts = result["posts"];
  assert.ok(Array.isArray(posts));
  assert.equal(posts.length, 2);
  assert.notEqual(
    Reflect.get(Object(posts[0]), "commandId"),
    Reflect.get(Object(posts[1]), "commandId"),
  );
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

await test("CLV-361 the page posts a workflow and retains the full queue command on a retry", () => {
  const result = played(
    { ...queued(), cardForms: [] },
    `
const model = JSON.parse(process.env.WATCH_MODEL);
const posts = [];
const plain = globalThis.fetch;
globalThis.fetch = (address, options) => {
  if (options?.method === "POST") {
    posts.push({ address, headers: options.headers, body: JSON.parse(options.body) });
    if (posts.length === 1) return Promise.reject(new Error("lost"));
  }
  return plain(address, options);
};
location.hash = "";
replies.push(model);
await load();
replies.push(model);
await queuePost("develop-issue", { command: "drain" });
replies.push({ command: "drain" }, model);
await queuePost("develop-issue", { command: "drain" });
replies.push({ lanes: 3 }, model);
await queuePost("develop-issue", { command: "lanes", lanes: 3, expectedLanes: 2 });
console.log(JSON.stringify({ posts, html: app.inner }));
`,
  );
  const posts = result["posts"];
  assert.ok(Array.isArray(posts));
  assert.equal(posts.length, 3);
  assert.deepEqual(posts[0], posts[1]);
  for (const post of posts) {
    assert.equal(Reflect.get(Object(post), "address"), "actions/queue");
    const headers: unknown = Reflect.get(Object(post), "headers");
    assert.equal(
      Reflect.get(Object(headers), "x-cloving-token"),
      "a".repeat(64),
    );
    const body: unknown = Reflect.get(Object(post), "body");
    assert.equal(Reflect.get(Object(body), "workflowId"), "develop-issue");
    assert.equal(typeof Reflect.get(Object(body), "commandId"), "string");
  }
  const last: unknown = Reflect.get(Object(posts[2]), "body");
  assert.equal(Reflect.get(Object(last), "lanes"), 3);
  assert.equal(Reflect.get(Object(last), "expectedLanes"), 2);
});
