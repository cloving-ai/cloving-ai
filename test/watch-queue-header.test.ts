import assert from "node:assert/strict";
import { test } from "node:test";
import { component } from "../src/cli/watch-element.ts";
import type { RepositoryQueueControls } from "../src/cli/watch-header-view.ts";
import { Page, type QueueControls } from "../src/cli/watch-view.ts";
import { played } from "./watch-browser.ts";
import { found, rendered } from "./watch-dom.ts";
import { floorModel } from "./watch-floor-fixture.ts";
import { noCopy } from "./watch-sample.ts";

interface Shown {
  readonly states?: readonly string[];
  readonly repositoryQueue: RepositoryQueueControls;
  readonly queue?: QueueControls;
  readonly selected?: string;
}

function shownPage(shown: Shown) {
  const { states, repositoryQueue } = shown;
  const queues = states?.map((state, index) => ({
    workflowId: index === 0 ? "develop-issue" : "idea",
    state,
    lanes: 2,
    busy: 0,
    skipped: [],
  }));
  const model = {
    ...floorModel([]),
    ...(queues === undefined ? {} : { queues }),
  };
  return component(Page, {
    model,
    selected: shown.selected ?? "",
    now: model.updatedAt,
    stale: false,
    copying: noCopy,
    queue: shown.queue,
    repositoryQueue,
  });
}

function headerButtons(shown: Shown) {
  return found(shownPage(shown), "button").filter(
    (item) => item["class"] === "queue-control",
  );
}

function invoke(handler: unknown) {
  assert.ok(typeof handler === "function");
  Reflect.apply(handler, undefined, []);
}

await test("#837 with one queue the header shows the Drain queue or Resume queue control of 1.9.0", () => {
  const commands: string[] = [];
  const repositoryQueue: RepositoryQueueControls = {
    busy: false,
    message: "",
    onCommand: (command) => {
      commands.push(command);
    },
  };
  const running = headerButtons({
    states: ["running"],
    repositoryQueue,
  });
  assert.deepEqual(
    running.map((item) => item["children"]),
    ["Drain queue"],
  );
  assert.equal(running[0]?.["disabled"], undefined);
  invoke(running[0]?.["onClick"]);
  const drained = headerButtons({
    states: ["drained"],
    repositoryQueue,
  });
  assert.deepEqual(
    drained.map((item) => item["children"]),
    ["Resume queue"],
  );
  invoke(drained[0]?.["onClick"]);
  assert.deepEqual(commands, ["drain", "resume"]);
});

await test("#837 the header shows no queue control without exactly one queue", () => {
  const repositoryQueue: RepositoryQueueControls = {
    busy: false,
    message: "",
    onCommand: () => undefined,
  };
  const commands: Parameters<QueueControls["onCommand"]>[] = [];
  const queue: QueueControls = {
    busy: [],
    messages: {},
    onCommand: (...args) => {
      commands.push(args);
    },
    onLanes: () => undefined,
  };
  const two = { states: ["running", "drained"], repositoryQueue, queue };
  assert.deepEqual(headerButtons(two), []);
  const cards = found(shownPage(two), "button").filter(
    (item) => item["class"] === "queue-drain",
  );
  assert.deepEqual(
    cards.map((item) => item["children"]),
    ["Drain", "Resume"],
  );
  cards.forEach((item) => {
    invoke(item["onClick"]);
  });
  assert.deepEqual(commands, [
    ["develop-issue", "drain"],
    ["idea", "resume"],
  ]);
  assert.deepEqual(headerButtons({ states: [], repositoryQueue }), []);
  assert.deepEqual(headerButtons({ repositoryQueue }), []);
  assert.deepEqual(headerButtons({ states: ["off"], repositoryQueue }), []);
});

await test("#837 the header control keeps the 1.9.0 busy state and message", () => {
  const busy: RepositoryQueueControls = {
    busy: true,
    message: "The watch tool does not answer.",
    onCommand: () => undefined,
  };
  assert.equal(
    headerButtons({ states: ["running"], repositoryQueue: busy })[0]?.[
      "disabled"
    ],
    true,
  );
  const header = rendered(
    shownPage({ states: ["running"], repositoryQueue: busy }),
  ).split("</header>")[0];
  assert.match(
    header ?? "",
    /<span class="queue-message">The watch tool does not answer\.<\/span>/,
  );
});

await test("#837 the board and run headers show the same repository queue control", () => {
  const commands: string[] = [];
  const repositoryQueue: RepositoryQueueControls = {
    busy: false,
    message: "",
    onCommand: (command) => {
      commands.push(command);
    },
  };
  for (const selected of ["#workflow=develop-issue", "#run=run-1"]) {
    const buttons = headerButtons({
      states: ["running"],
      repositoryQueue,
      selected,
    });
    assert.deepEqual(
      buttons.map((item) => item["children"]),
      ["Drain queue"],
      selected,
    );
    invoke(buttons[0]?.["onClick"]);
  }
  assert.deepEqual(commands, ["drain", "drain"]);
});

const headerScene = `
const model = JSON.parse(process.env.WATCH_MODEL);
const posts = [];
const answers = [];
const plain = globalThis.fetch;
globalThis.fetch = (address, options) => {
  if (options?.method !== "POST") return plain(address, options);
  posts.push({ address, headers: options.headers, body: options.body });
  return answers.shift()();
};
location.hash = "";
replies.push(model);
await load();
const header = () => app.all("header")[0];
const button = () => header().all("button").find((node) => node.getAttribute("class") === "queue-control");
const seen = [];
let release;
answers.push(() => new Promise((resolve) => { release = resolve; }));
replies.push(model);
button().dispatch("click");
await settled();
seen.push(header().html);
release({ ok: true, json: () => Promise.resolve({ error: { code: "queue-unavailable", detail: "The service has no queue workflow." } }) });
for (let turn = 0; turn < 5; turn++) await settled();
seen.push(header().html);
answers.push(() => Promise.reject(new Error("lost")));
replies.push(model);
button().dispatch("click");
for (let turn = 0; turn < 5; turn++) await settled();
seen.push(header().html);
answers.push(() => Promise.resolve({ ok: false, status: 403 }));
replies.push(model);
button().dispatch("click");
for (let turn = 0; turn < 5; turn++) await settled();
seen.push(header().html);
console.log(JSON.stringify({ posts, seen }));
`;

await test("#837 the header control posts the 1.9.0 command with no workflow ID and shows its busy state and message", () => {
  const model = {
    ...floorModel([]),
    queues: [
      {
        workflowId: "develop-issue",
        state: "running",
        lanes: 2,
        busy: 0,
        skipped: [],
      },
    ],
    cardForms: [],
  };
  const result = played(model, headerScene);
  const post = {
    address: "actions/queue",
    headers: {
      "content-type": "application/json",
      "x-cloving-token": "a".repeat(64),
    },
    body: '{"command":"drain"}',
  };
  assert.deepEqual(result["posts"], [post, post, post]);
  const seen = result["seen"];
  assert.ok(Array.isArray(seen));
  const button = '<button type="button" class="queue-control"';
  const message = (text: string) =>
    `${button}>Drain queue</button><span class="queue-message">${text}</span>`;
  assert.deepEqual(
    seen.map(
      (html) =>
        /<button type="button" class="queue-control"[^>]*>[^<]*<\/button>(<span class="queue-message">[^<]*<\/span>)?/.exec(
          String(html),
        )?.[0],
    ),
    [
      `${button} disabled="true">Drain queue</button>`,
      message("The service has no queue workflow."),
      message("The watch tool does not answer."),
      message("The watch page refused the request. Refresh the page."),
    ],
  );
});
