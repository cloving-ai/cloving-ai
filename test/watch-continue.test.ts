import assert from "node:assert/strict";
import { test } from "node:test";
import type { Reply, ServiceRequest } from "../src/protocol.ts";
import { component } from "../src/cli/watch-element.ts";
import type { WatchModel } from "../src/cli/watch-render.ts";
import { Page, type ContinueControls } from "../src/cli/watch-view.ts";
import { actionHeaders, pageToken, postCard } from "./watch-action-fixture.ts";
import { played } from "./watch-browser.ts";
import { found, rendered } from "./watch-dom.ts";
import { floorModel, floorRun } from "./watch-floor-fixture.ts";
import { noCopy } from "./watch-sample.ts";
import { withWatchService } from "./watch-service-fixture.ts";

const controls: ContinueControls = {
  busy: [],
  messages: {},
  onContinue: () => undefined,
};

function stoppedRun(
  runId: string,
  status: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const run = floorRun(runId, {
    operation: "github-merge",
    minutes: 30,
    ticketId: "592",
    reason: { code: "git-call-failed", detail: "The push was rejected." },
  });
  const shown = run["status"];
  return {
    ...run,
    status: { ...(typeof shown === "object" ? shown : {}), ...status },
  };
}

const stoppedModel = floorModel([
  stoppedRun("failed-merge", { state: "failed" }),
  stoppedRun("blocked-merge", {
    state: "completed",
    outcome: { kind: "blocked" },
  }),
  stoppedRun("continued-merge", { state: "failed", continuedBy: "run-new" }),
  stoppedRun("handed-off", {
    state: "completed",
    outcome: { kind: "handoff_requested" },
  }),
]);

function page(model: WatchModel, continuing?: ContinueControls) {
  return component(Page, {
    model,
    selected: "",
    now: model.updatedAt,
    stale: false,
    copying: noCopy,
    ...(continuing === undefined ? {} : { continuing }),
  });
}

function panel(html: string): string {
  return /<section class="needs"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
}

await test("CLV-307 Needs you lists a failed run and a blocked run with no continuation, and the page token adds Continue", () => {
  const plain = panel(rendered(page(stoppedModel)));
  assert.deepEqual(
    [...plain.matchAll(/<a class="need-action" href="#run=([^"]+)">/g)]
      .map((match) => match[1])
      .toSorted(),
    ["blocked-merge", "failed-merge"],
  );
  assert.match(
    plain,
    /<p class="need-text">The push was rejected\. Examine the run, then continue it or take it over\.<\/p>/,
  );
  assert.equal(plain.includes("<button"), false);
  const buttons = found(page(stoppedModel, controls), "button").filter(
    (button) => button["class"] === "need-action need-continue",
  );
  assert.deepEqual(
    buttons.map((button) => [button["children"], button["disabled"]]),
    [
      ["Continue", undefined],
      ["Continue", undefined],
    ],
  );
  const waiting = page(stoppedModel, {
    ...controls,
    busy: ["failed-merge"],
    messages: { "blocked-merge": "continuation-step-required: Name it." },
  });
  assert.deepEqual(
    found(waiting, "button")
      .map((button) => button["disabled"])
      .toSorted(),
    [true, undefined],
  );
  assert.match(
    panel(rendered(waiting)),
    /<p class="need-message">continuation-step-required: Name it\.<\/p>/,
  );
});

function answered(requests: ServiceRequest[]) {
  return (request: ServiceRequest): Reply => {
    if (request.operation !== "continue-run")
      return { kind: "result", result: { runs: [], workflows: [] } };
    requests.push(request);
    if (request.parameters["runId"] === "blocked-merge")
      return {
        kind: "error",
        error: {
          code: "continuation-step-required",
          detail: "Name a step with --from.",
        },
      };
    return {
      kind: "result",
      result: { kind: "run-continued", runId: "run-new" },
    };
  };
}

await test("CLV-307 the continue action of the page sends continue-run only with the page token", () => {
  const requests: ServiceRequest[] = [];
  return withWatchService(answered(requests), async (watch) => {
    const good = actionHeaders(watch, await pageToken(watch));
    const sent = (body: string, headers = good) =>
      postCard(watch, { path: "actions/continue", headers, body });
    const forged = { ...good, "x-cloving-token": "b".repeat(64) };
    assert.equal((await sent('{"runId":"failed-merge"}', forged)).status, 403);
    for (const body of ['{"runId":"bad id"}', "[]", "{"])
      assert.equal((await sent(body)).status, 403, body);
    assert.equal(requests.length, 0);
    const replies = [];
    for (const runId of ["failed-merge", "blocked-merge"]) {
      const reply = await sent(JSON.stringify({ runId }));
      assert.equal(reply.status, 200);
      replies.push(JSON.parse(reply.body));
    }
    assert.deepEqual(replies, [
      { kind: "run-continued", runId: "run-new" },
      {
        error: {
          code: "continuation-step-required",
          detail: "Name a step with --from.",
        },
      },
    ]);
    assert.deepEqual(
      requests.map((request) => request.parameters["runId"]),
      ["failed-merge", "blocked-merge"],
    );
    const identifiers = requests.map((request) =>
      String(request.parameters["commandId"]),
    );
    for (const commandId of identifiers)
      assert.match(commandId, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
    assert.equal(new Set(identifiers).size, 2);
  });
});

await test("CLV-307 Continue posts the run with the page token, shows the reply, and loads the page data again", () => {
  const model = {
    ...floorModel([stoppedRun("failed-merge", { state: "failed" })]),
    cardForms: [],
  };
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
const button = () => app.all("button").find((node) => node.inner === "Continue");
replies.push({ error: { code: "continuation-step-required", detail: "Name a step with --from." } }, model);
button().dispatch("click");
for (let turn = 0; turn < 5; turn++) await settled();
console.log(JSON.stringify({ posts, requests, html: app.inner }));
`,
  );
  assert.deepEqual(result["posts"], [
    {
      address: "actions/continue",
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
    "actions/continue",
    "data.json",
  ]);
  assert.match(
    String(result["html"]),
    /<p class="need-message">continuation-step-required: Name a step with --from\.<\/p>/,
  );
});
