import { writeDeclaredWorkflow } from "./workflow-folder-fixture.ts";
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
    const { workflow } = await writeDeclaredWorkflow(harness.projectDirectory);
    const service = await harness.start({
      workflows: [
        {
          ...harness.registration,
          workflowId: workflow.workflowId,
          manifest: {
            ...harness.registration.manifest,
            queue: workflow.queue ?? false,
          },
          admission: 4,
          submission: workflow.input,
          resolver: {
            ...harness.registration.resolver,
            resolve: () =>
              Promise.resolve({ kind: "resolved", input: { ticketId: "900" } }),
            skippedTickets: () => [queue.skipped[1] ?? {}],
          },
        },
      ],
    });
    const admitted = await call(harness, {
      operation: "run",
      parameters: {
        workflowId: "develop",
        source: "input",
        commandId: "busy",
        submission: { ticket: "900" },
      },
    });
    assert.equal(admitted["kind"], "run-admitted");
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

for (const spentUsd of [17.1, 21.1, null])
  await test(`CLV-241 status and both watch renders show queue spend ${String(spentUsd)}`, () => {
    const spend = {
      limitUsd: 20,
      spentUsd,
      unknownTurns: 1,
      turnsInWork: 2,
      windowHours: 24,
      holding: spentUsd !== null,
    };
    const model = { ...sampleModel([]), queue: { ...queue, spend } };
    const cli = statusText({
      kind: "run-list",
      workflows: [],
      runs: [],
      queue: model.queue,
    });
    const html = rendered(
      component(Page, {
        model,
        selected: "",
        now: at("21:34:41"),
        stale: false,
        copying: noCopy,
      }),
    );
    const browser = played(
      model,
      `location.hash = ""; replies.push(JSON.parse(process.env.WATCH_MODEL)); await load(); console.log(JSON.stringify({ html: app.inner }));`,
    );
    for (const text of [cli, html, String(browser["html"])]) {
      assert.match(
        text,
        spentUsd === null
          ? /Spend: Price not known of 20.00 USD in the last 24 hours/
          : new RegExp(
              `Spend: ${spentUsd.toFixed(2)} of 20.00 USD in the last 24 hours`,
            ),
      );
      assert.match(text, /1 turn with unknown cost/);
      assert.match(text, /2 turns in work/);
      assert.equal(text.includes("Queue holds new runs"), spentUsd !== null);
      assert.equal(text.includes("over the limit"), spentUsd === 21.1);
      assert.doesNotMatch(text, /Spend: 0.00/);
    }
  });
