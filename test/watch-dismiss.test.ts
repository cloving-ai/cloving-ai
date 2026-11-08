import assert from "node:assert/strict";
import { test } from "node:test";
import type { Reply, ServiceRequest } from "../src/protocol.ts";
import { component } from "../src/cli/watch-element.ts";
import { Page, type ContinueControls } from "../src/cli/watch-view.ts";
import { actionHeaders, pageToken, postCard } from "./watch-action-fixture.ts";
import { played } from "./watch-browser.ts";
import { found, rendered } from "./watch-dom.ts";
import { floorModel, floorRun } from "./watch-floor-fixture.ts";
import { noCopy } from "./watch-sample.ts";
import { withWatchService } from "./watch-service-fixture.ts";

const dismissed: string[] = [];

const controls: ContinueControls = {
  busy: [],
  messages: {},
  open: null,
  note: "",
  onOpen: () => undefined,
  onClose: () => undefined,
  onNote: () => undefined,
  onContinue: () => undefined,
  onDismiss: (runId) => {
    dismissed.push(runId);
  },
};

const model = floorModel([
  floorRun("failed-merge", {
    operation: "github-merge",
    minutes: 30,
    state: "failed",
  }),
  floorRun("paused-merge", {
    operation: "github-merge",
    minutes: 20,
    state: "paused",
  }),
]);

function page(continuing?: ContinueControls) {
  return component(Page, {
    model,
    selected: "",
    now: model.updatedAt,
    stale: false,
    copying: noCopy,
    ...(continuing === undefined ? {} : { continuing }),
  });
}

await test("CLV-321 with the page token, each stopped run in Needs you has a Dismiss action", () => {
  assert.equal(rendered(page()).includes("Dismiss"), false);
  const buttons = found(page(controls), "button").filter(
    (button) => button["class"] === "need-action need-dismiss",
  );
  assert.deepEqual(
    buttons.map((button) => button["children"]),
    ["Dismiss"],
  );
  const click = buttons[0]?.["onClick"];
  assert.ok(typeof click === "function");
  Reflect.apply(click, undefined, []);
  assert.deepEqual(dismissed, ["failed-merge"]);
  const waiting = found(
    page({ ...controls, busy: ["failed-merge"] }),
    "button",
  ).filter((button) => button["class"] === "need-action need-dismiss");
  assert.deepEqual(
    waiting.map((button) => button["disabled"]),
    [true],
  );
});

function answered(requests: ServiceRequest[]) {
  return (request: ServiceRequest): Reply => {
    if (request.operation !== "dismiss-run")
      return { kind: "result", result: { runs: [], workflows: [] } };
    requests.push(request);
    return {
      kind: "result",
      result: { kind: "run-dismissed", runId: request.parameters["runId"] },
    };
  };
}

await test("CLV-321 the dismiss action of the page sends dismiss-run only with the page token", () => {
  const requests: ServiceRequest[] = [];
  return withWatchService(answered(requests), async (watch) => {
    const good = actionHeaders(watch, await pageToken(watch));
    const sent = (body: string, headers = good) =>
      postCard(watch, { path: "actions/dismiss", headers, body });
    const forged = { ...good, "x-cloving-token": "b".repeat(64) };
    assert.equal((await sent('{"runId":"failed-merge"}', forged)).status, 403);
    for (const body of ['{"runId":"bad id"}', "[]", "{"])
      assert.equal((await sent(body)).status, 403, body);
    assert.equal(requests.length, 0);
    const reply = await sent('{"runId":"failed-merge"}');
    assert.equal(reply.status, 200);
    assert.deepEqual(JSON.parse(reply.body), {
      kind: "run-dismissed",
      runId: "failed-merge",
    });
    assert.deepEqual(
      requests.map((request) => request.parameters["runId"]),
      ["failed-merge"],
    );
    assert.match(
      String(requests[0]?.parameters["commandId"]),
      /^[0-9a-f]{8}-[0-9a-f-]{27}$/,
    );
  });
});

await test("CLV-321 Dismiss posts the run with the page token, shows a refusal, and loads the page data again", () => {
  const result = played(
    { ...model, cardForms: [] },
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
const button = () => app.all("button").find((node) => node.inner === "Dismiss");
replies.push({ error: { code: "run-active", detail: "The run is active." } }, model);
button().dispatch("click");
for (let turn = 0; turn < 5; turn++) await settled();
console.log(JSON.stringify({ posts, requests, html: app.inner }));
`,
  );
  assert.deepEqual(result["posts"], [
    {
      address: "actions/dismiss",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cloving-token": "a".repeat(64),
      },
      body: '{"runId":"failed-merge"}',
    },
  ]);
  assert.deepEqual(result["requests"], [
    "phone.json",
    "data.json",
    "actions/dismiss",
    "data.json",
  ]);
  assert.match(
    String(result["html"]),
    /<p class="need-message">run-active: The run is active\.<\/p>/,
  );
});
