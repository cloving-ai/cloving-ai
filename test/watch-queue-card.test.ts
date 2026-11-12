import { withWatchService, watchData } from "./watch-service-fixture.ts";
import { workspaceModel } from "../src/cli/watch-workspace.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { component } from "../src/cli/watch-element.ts";
import { Floor } from "../src/cli/watch-floor-view.ts";
import { rendered } from "./watch-dom.ts";
import { floorModel } from "./watch-floor-fixture.ts";

const queue = {
  workflowId: "develop-issue",
  state: "running",
  busy: 6,
  lanes: 8,
  nextCheckAt: "2026-11-03T09:42:00.000Z",
  settings: {
    everySeconds: { value: 120, source: "declaration" },
    lanes: { value: 8, source: "environment" },
    workingLanes: { value: 8, source: "default" },
  },
  skipped: [{ ticketId: "123", reason: "ticket-active" }],
};

function floor(changes: Record<string, unknown> = {}) {
  const model = { ...floorModel([]), queues: [{ ...queue, ...changes }] };
  return rendered(component(Floor, { model, now: model.updatedAt }));
}

await test("CLV-361 each queue ends its workflow row with its interval, lanes, next check, sources and folded skipped tickets", () => {
  const html = floor();
  assert.match(html, /class="line-queue queue-running"/);
  assert.match(html, /running · every 2 min/);
  assert.match(html, /6 of 8 lanes busy/);
  assert.equal((html.match(/class="lane busy"/g) ?? []).length, 6);
  assert.equal((html.match(/class="lane free"/g) ?? []).length, 2);
  assert.match(html, /next check /);
  assert.match(html, /interval: declaration/);
  assert.match(html, /lanes: environment/);
  assert.match(html, /working lanes: default/);
  assert.match(
    html,
    /<details class="queue-waiting"><summary>1 ticket skipped/,
  );
  assert.match(html, /#123 is in work/);
  assert.doesNotMatch(html, /<button|role="switch"/);
  const rows = html.split('<li class="line">');
  assert.match(rows[1] ?? "", /line-queue/);
  assert.doesNotMatch(rows[2] ?? "", /line-queue/);
});

await test("CLV-361 held queues show the present hold text only while running, and off and stopped queues explain why", () => {
  assert.match(
    floor({ hold: { text: "Waiting for a free lane." } }),
    /held · every 2 min/,
  );
  assert.match(
    floor({ hold: { text: "Waiting for a free lane." } }),
    /held: Waiting for a free lane\./,
  );
  assert.match(
    floor({ state: "draining", hold: { text: "Old hold" } }),
    /draining · every 2 min/,
  );
  assert.doesNotMatch(
    floor({ state: "draining", hold: { text: "Old hold" } }),
    /held:|Old hold/,
  );
  assert.match(floor({ state: "drained" }), /drained · every 2 min/);
  assert.match(
    floor({ state: "off", off: { reason: "state off in the queues setting" } }),
    /Queue off/,
  );
  assert.match(
    floor({ state: "off", off: { reason: "no ticket command" } }),
    /no ticket command/,
  );
  assert.match(
    floor({ state: "stopped", stop: { reason: "disk failed" } }),
    /the queue stopped: disk failed/,
  );
});

await test("CLV-361 the watch model retains every queue and places each ready count on its own workflow", async () => {
  const queues = [
    queue,
    { ...queue, workflowId: "idea", ready: { count: 2, oldestAt: null } },
  ];
  await withWatchService(
    () => ({
      kind: "result",
      result: {
        workflows: ["develop-issue", "idea"],
        runs: [],
        queues,
      },
    }),
    async (watch) => {
      const model = await watchData(watch.address);
      assert.deepEqual(model["queues"], queues);
      const workflows = model["workflows"];
      assert.ok(Array.isArray(workflows));
      assert.deepEqual(Reflect.get(Object(workflows[1]), "ready"), {
        count: 2,
        oldestAt: null,
      });
    },
  );
});

await test("CLV-361 the hold label uses the present reason without a second Held prefix", () => {
  assert.match(floor({ hold: { text: "Held: load high" } }), /held: load high/);
});

await test("CLV-361 a workspace keeps each repository queue on its own workflow row", () => {
  const model = workspaceModel([
    { name: "first", model: floorModel([], { queue }) },
    { name: "second", model: floorModel([], { queue: { ...queue, busy: 1 } }) },
  ]);
  const html = rendered(component(Floor, { model, now: model.updatedAt }));
  assert.equal((html.match(/class="line-queue /g) ?? []).length, 2);
  const repositories = html.split('<li class="repository">');
  assert.match(repositories[1] ?? "", /6 of 8 lanes busy/);
  assert.match(repositories[2] ?? "", /1 of 8 lanes busy/);
  assert.doesNotMatch(html, /<button|role="switch"/);
});

await test("CLV-361 queue intervals use hours or seconds when minutes do not fit, and off defaults to its setting reason", () => {
  assert.match(
    floor({
      settings: { everySeconds: { value: 3600, source: "declaration" } },
    }),
    /running · every 1 h/,
  );
  assert.match(
    floor({ settings: { everySeconds: { value: 45, source: "declaration" } } }),
    /running · every 45 s/,
  );
  assert.match(floor({ state: "off" }), /state off in the queues setting/);
});
