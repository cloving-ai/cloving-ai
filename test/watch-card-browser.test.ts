import { exampleCardForms } from "./watch-action-fixture.ts";
import { browserExecutable } from "./watch-real-browser.ts";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { WatchModel } from "../src/cli/watch-render.ts";
import { shownWait, waitModel } from "./command-wait-display-fixture.ts";
import { test } from "node:test";
import { pageDocument } from "../src/cli/watch-page.ts";
import type { CardForm } from "../src/cli/watch-run-input.ts";
import { boardModel } from "./watch-board-fixture.ts";
import { realBrowser } from "./watch-real-browser.ts";

interface BoardOptions {
  readonly form?: CardForm | undefined;
  readonly model?: WatchModel;
}

async function cardBoard(
  workflowId = "idea-to-issue",
  options: BoardOptions = {},
) {
  const library = await readFile(new URL(import.meta.resolve("preact")));
  const page = pageDocument("a".repeat(64)).replace(
    /<link rel="stylesheet"[^>]*>/,
    "",
  );
  const streams = new Set<ServerResponse>();
  let model = options.model ?? {
    ...boardModel([], { workflows: [workflowId] }),
    cardForms: options.form === undefined ? exampleCardForms() : [options.form],
  };
  const server = createServer((request, response) => {
    if (request.url === "/preact.mjs") {
      response
        .writeHead(200, { "content-type": "text/javascript" })
        .end(library);
      return;
    }
    if (request.url === "/data.json") {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(model));
      return;
    }
    if (request.url === "/events") {
      streams.add(response);
      response.on("close", () => streams.delete(response));
      response
        .writeHead(200, { "content-type": "text/event-stream" })
        .write("data: ready\n\n");
      return;
    }
    response
      .writeHead(200, {
        "content-type": "text/html",
        "content-security-policy": "default-src 'self' 'unsafe-inline' data:",
      })
      .end(page);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return {
    url: `http://127.0.0.1:${String(address.port)}/#workflow=${workflowId}`,
    update(next: WatchModel) {
      model = next;
      for (const stream of streams) stream.write("data: refreshed\n\n");
    },
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      await server[Symbol.asyncDispose]();
    },
  };
}

await test("CLV-135 opening a card focuses its input so immediate Escape closes it", async () => {
  await using board = await cardBoard();
  await using browser = await realBrowser();
  const page = await browser.page({ width: 800, height: 700 });
  await page.navigate(board.url);
  const result = await page.evaluate(`new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { clearInterval(timer); reject(new Error("board not loaded")); }, 5000);
    const timer = setInterval(() => {
      const button = [...document.querySelectorAll("button")].find((item) => item.textContent === "+ Add a card");
      if (!button) return;
      clearInterval(timer); clearTimeout(timeout);
      button.focus(); button.click();
      const focused = document.activeElement?.localName;
      document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      resolve({ focused, forms: document.querySelectorAll("form").length });
    }, 20);
  })`);
  assert.equal(result["focused"], "textarea");
  assert.equal(result["forms"], 0);
});

for (const [workflowId, modifiers, form] of [
  ["develop", {}, undefined],
  ["idea-to-issue", { ctrlKey: true }, undefined],
  ["idea-to-issue", { metaKey: true }, undefined],
  [
    "review-corpus",
    {},
    {
      workflowId: "review-corpus",
      source: "input",
      fields: [
        {
          name: "requestSubmit",
          label: "Request",
          multiline: false,
          optional: false,
        },
      ],
    },
  ],
] as const) {
  await test(`CLV-135 ${workflowId} keyboard submit ${JSON.stringify(modifiers)} validates required fields before a request`, async () => {
    await using board = await cardBoard(workflowId, { form });
    await using browser = await realBrowser();
    const page = await browser.page({ width: 800, height: 700 });
    await page.navigate(board.url);
    const result = await page.evaluate(`new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { clearInterval(timer); reject(new Error("board not loaded")); }, 5000);
      const timer = setInterval(() => {
        const button = [...document.querySelectorAll("button")].find((item) => item.textContent === "+ Add a card");
        if (!button) return;
        clearInterval(timer); clearTimeout(timeout);
        button.click(); resolve({});
      }, 20);
    }).then(async () => {
      const submissions = [];
      globalThis.fetch = async (address, options) => {
        submissions.push(JSON.parse(options.body));
        return { ok: true, json: async () => ({ kind: "result", result: { runId: "run-keyboard" } }) };
      };
      let invalid = 0;
      const form = document.querySelector("form");
      form.addEventListener("invalid", () => { invalid++; }, true);
      form.querySelector("button[type=submit]").click();
      const field = form.querySelector("input, textarea");
      const press = () => field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...${JSON.stringify(modifiers)} }));
      press();
      await new Promise(resolve => setTimeout(resolve, 0));
      const emptyRequests = submissions.length;
      field.value = "192";
      field.dispatchEvent(new Event("input", { bubbles: true }));
      press();
      await new Promise(resolve => setTimeout(resolve, 0));
      return { invalid, emptyRequests, submissions, message: form.querySelector("[role=status]").textContent };
    })`);
    assert.equal(result["emptyRequests"], 0);
    assert.equal(result["invalid"], 2);
    assert.ok(Array.isArray(result["submissions"]));
    assert.equal(result["submissions"].length, 1);
    assert.equal(result["message"], "Run run-keyboard is admitted");
  });
}

await test("CLV-136 browser checks select the native Chrome executable and preserve overrides", () => {
  assert.equal(browserExecutable("linux", undefined), "/usr/bin/google-chrome");
  assert.equal(
    browserExecutable("darwin", undefined),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  );
  assert.equal(
    browserExecutable("linux", "/synthetic/browser"),
    "/synthetic/browser",
  );
});

await test("CLV-238 the browser run card and detail refresh wait times and freeze at settlement", async () => {
  await using board = await cardBoard("review-queue", { model: waitModel() });
  await using browser = await realBrowser();
  const page = await browser.page({ width: 1000, height: 800 });
  await page.navigate(board.url);
  const snapshots = [
    shownWait,
    { ...shownWait, remainingSeconds: 2_159_999 },
    {
      ...shownWait,
      remainingSeconds: 2_159_999,
      state: "failed",
      nextCheckAt: null,
      reason: "command-wait-invalid-output",
    },
  ];
  for (const wait of snapshots) {
    board.update(waitModel(wait));
    const expected = `${String(wait.remainingSeconds)} s left`;
    for (const view of ["board", "detail"]) {
      const hash =
        view === "board"
          ? "workflow=review-queue"
          : "workflow=review-queue&run=run-1";
      const result = await page.evaluate(`new Promise((resolve, reject) => {
        location.hash = ${JSON.stringify(hash)};
        const timeout = setTimeout(() => { clearInterval(timer); reject(new Error("wait display not refreshed")); }, 5000);
        const timer = setInterval(() => {
          const root = document.querySelector(${JSON.stringify(view === "board" ? ".card" : ".run-usage")});
          const html = document.body.textContent;
          if (!root || !html.includes(${JSON.stringify(expected)}) || !html.includes(${JSON.stringify(wait.reason ?? "waiting")})) return;
          clearInterval(timer); clearTimeout(timeout); resolve({ html });
        }, 20);
      })`);
      const html = String(result["html"]);
      assert.ok(html.includes(expected));
      assert.ok(html.includes(String(wait.deadline)));
      assert.ok(html.includes(wait.nextCheckAt ?? "next check none"));
      assert.match(html, /1 of 2 effect units/);
      assert.doesNotMatch(html, /browser-(input|stdout|stderr|output)-fixture/);
    }
  }
  board.update({
    ...waitModel(snapshots[2]),
    updatedAt: "2026-10-25T00:00:00.000Z",
  });
  const frozen = await page.evaluate(
    `new Promise(resolve => setTimeout(() => resolve({ html: document.body.textContent }), 100))`,
  );
  assert.match(String(frozen["html"]), /2159999 s left/);
  assert.match(String(frozen["html"]), /command-wait-invalid-output/);
});
