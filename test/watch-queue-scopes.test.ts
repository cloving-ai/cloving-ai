import assert from "node:assert/strict";
import { test } from "node:test";
import { Page } from "../src/cli/watch-view.ts";
import { component } from "../src/cli/watch-element.ts";
import { found, rendered } from "./watch-dom.ts";
import { floorModel } from "./watch-floor-fixture.ts";
import { noCopy } from "./watch-sample.ts";
import { QueueCard } from "../src/cli/watch-queue-card-view.ts";
import {
  QueueMeter,
  GlobalQueue,
  QueueInheritance,
} from "../src/cli/watch-queue-setting-view.ts";

const queue = {
  workflowId: "develop-issue",
  state: "running",
  lanes: 2,
  busy: 3,
  ready: { count: 7 },
  settings: {
    workingLanes: { value: 1, source: "queues setting (private file)" },
  },
};
const model = {
  ...floorModel([]),
  queues: [queue],
  globalQueue: {
    state: "running",
    lanes: 8,
    busy: 5,
    configuredLanes: 8,
    workingLanes: 8,
    configuredWorkingLanes: null,
    eligible: true,
  },
};

await test("CLV-377 the frozen compact queue layout keeps its segmented meter visible and global controls in the sidebar", () => {
  const shown = component(Page, {
    model,
    selected: "",
    now: model.updatedAt,
    stale: false,
    copying: noCopy,
  });
  const text = rendered(shown);
  assert.match(text, /Global queue running, 5 of 8 global lanes busy/);
  assert.match(text, /3 in progress · <span class="line-ready">7 ready/);
  assert.match(text, /More/);
  assert.match(text, /No queue configured/);
  const meters = found(shown, "span").filter(
    (item) => item["class"] === "lanes queue-meter",
  );
  assert.equal(meters.length, 2);
  const details = found(shown, "details").filter(
    (item) => item["class"] === "queue-more",
  );
  assert.equal(details.length, 2);
  assert.ok(details.every((item) => item["open"] === undefined));
  assert.equal(
    found(shown, "header").some((item) =>
      rendered(item["children"]).includes("Global queue"),
    ),
    false,
  );
  const sidebar = found(shown, "aside").find(
    (item) => item["class"] === "side-panels",
  );
  assert.match(rendered(sidebar?.["children"]), /Global queue/);
});

await test("CLV-377 workflow boards show only their own queue and manual boards report no queue", () => {
  for (const selected of ["#workflow=develop-issue", "#workflow=idea"]) {
    const shown = component(Page, {
      model,
      selected,
      now: model.updatedAt,
      stale: false,
      copying: noCopy,
    });
    assert.match(
      rendered(shown),
      selected.endsWith("idea")
        ? /No queue configured/
        : /3 in progress · <span class="line-ready">7 ready/,
    );
  }
});

await test("CLV-377 meters preserve empty, partial, full and over-limit occupancy with accessible labels", () => {
  for (const busy of [0, 1, 2, 3]) {
    const shown = component(QueueMeter, { queue: { busy, lanes: 2 } });
    const spans = found(shown, "span");
    assert.equal(spans[0]?.["aria-label"], `${String(busy)} of 2 lanes busy`);
    assert.equal(
      spans.filter((item) => item["class"] === "lane busy").length,
      busy,
    );
    assert.equal(
      spans.filter((item) => item["class"] === "lane free").length,
      Math.max(0, 2 - busy),
    );
  }
});

await test("CLV-377 private global inheritance is visible and an advanced global work hold stays honest", () => {
  const changes: unknown[] = [];
  const controls = {
    busy: [],
    messages: {},
    onCommand: () => undefined,
    onLanes: () => undefined,
    onSetting: (change: unknown) => {
      changes.push(change);
    },
  };
  const global = {
    ...model.globalQueue,
    busy: 2,
    lanes: 4,
    workingLanes: 1,
    working: 1,
    sources: {
      lanes: "queue setting (private file)",
      workingLanes: "queue setting (private file)",
    },
  };
  const inherited = component(QueueInheritance, {
    queue: global,
    controls,
    field: "lanes",
  });
  const reset = found(inherited, "button")[0]?.["onClick"];
  assert.ok(typeof reset === "function");
  Reflect.apply(reset, undefined, []);
  assert.deepEqual(changes, [
    { scope: "global", field: "lanes", expectedValue: 4, action: "inherit" },
  ]);
  assert.match(rendered(inherited), /private override/);
  assert.match(
    rendered(component(GlobalQueue, { queue: global, controls })),
    /Active-work cap reached · new starts wait/,
  );
});

await test("CLV-377 unresolved scoped failures remain visible after refresh disables editing", () => {
  const controls = {
    busy: [],
    messages: {
      "develop-issue":
        "The workflow save failed. Refresh and check permissions.",
      "@global": "The global result is unknown. Refresh and check the daemon.",
    },
    retry: ["develop-issue", "@global"],
    onCommand: () => undefined,
    onLanes: () => undefined,
    onRetry: () => undefined,
  };
  for (const [view, available, unavailable, message] of [
    [
      QueueCard,
      queue,
      { ...queue, state: "off" },
      controls.messages["develop-issue"],
    ],
    [
      GlobalQueue,
      model.globalQueue,
      { ...model.globalQueue, state: "unavailable", eligible: false },
      controls.messages["@global"],
    ],
  ] as const) {
    assert.ok(
      rendered(component(view, { queue: available, controls })).includes(
        message,
      ),
    );
    const refreshed = component(view, { queue: unavailable, controls });
    assert.ok(rendered(refreshed).includes(message));
    assert.equal(
      found(refreshed, "div").filter((item) => item["role"] === "alert").length,
      1,
    );
    assert.equal(found(refreshed, "button").length, 0);
  }
});
