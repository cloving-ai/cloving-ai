import assert from "node:assert/strict";
import { test } from "node:test";
import { rendered as statusText } from "../src/cli/render.ts";
import { component } from "../src/cli/watch-element.ts";
import { Page } from "../src/cli/watch-view.ts";
import { call, withHarness } from "./service-fixture.ts";
import { rendered } from "./watch-dom.ts";
import { played } from "./watch-browser.ts";
import { at, noCopy, sampleModel } from "./watch-sample.ts";
import {
  watchData,
  withWatchService,
  watchReplies,
} from "./watch-service-fixture.ts";

const queue = {
  lanes: 4,
  busy: 1,
  skipped: [
    { ticketId: "900", reason: "ticket-active" },
    {
      ticketId: "901",
      reason: "ticket-dependency-open",
      dependencies: ["899"],
    },
  ],
};

await test("CLV-184 service status and CLI show busy lanes and skipped tickets", () =>
  withHarness(async (harness) => {
    const service = await harness.start({
      workflows: [
        {
          ...harness.registration,
          workflowId: "develop-issue",
          admission: 4,
          resolver: {
            ...harness.registration.resolver,
            resolve: () =>
              Promise.resolve({ kind: "resolved", input: { ticketId: "900" } }),
            skippedTickets: () => [queue.skipped[1] ?? {}],
          },
        },
      ],
    });
    await call(harness, {
      operation: "run",
      parameters: {
        workflowId: "develop-issue",
        commandId: "busy",
        submission: { prompt: "Task" },
      },
    });
    const status = await call(harness, { operation: "status", parameters: {} });
    assert.deepEqual(status["queue"], queue);
    const text = statusText(status);
    assert.match(text, /Queue: 1 of 4 lanes busy/);
    assert.match(text, /900.*ticket-active/);
    assert.match(text, /901.*ticket-dependency-open.*899/);
    await service.close();
  }));

await test("CLV-184 watch data and page retain queue lanes and skip reasons", async () => {
  const base = watchReplies({ runs: [] });
  await withWatchService(
    (request) => {
      const response = base.answer(request);
      return request.operation === "status" && response.kind === "result"
        ? { ...response, result: { ...response.result, queue } }
        : response;
    },
    async (watch) => {
      const model = await watchData(watch.address);
      assert.deepEqual(model["queue"], queue);
    },
  );
  const html = rendered(
    component(Page, {
      model: { ...sampleModel([]), queue },
      selected: "",
      now: at("21:34:41"),
      stale: false,
      copying: noCopy,
    }),
  );
  assert.match(html, /Queue: 1 of 4 lanes busy/);
  assert.match(html, /#900 is in work/);
  assert.match(html, /#901 waits for #899/);
});

for (const hash of ["", "#workflow=develop-issue"])
  await test(`CLV-184 embedded watch script shows queue lanes and skip reasons at ${hash}`, () => {
    const model = { ...sampleModel([]), queue };
    const result = played(
      model,
      `
location.hash = ${JSON.stringify(hash)};
replies.push(JSON.parse(process.env.WATCH_MODEL));
await load();
console.log(JSON.stringify({ html: app.inner }));
`,
    );
    assert.match(String(result["html"]), /Queue: 1 of 4 lanes busy/);
    assert.match(String(result["html"]), /#900 is in work/);
    assert.match(String(result["html"]), /#901 waits for #899/);
  });
