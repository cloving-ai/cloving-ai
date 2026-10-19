import { browserExecutable } from "./watch-real-browser.ts";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { test } from "node:test";
import { pageDocument } from "../src/cli/watch-page.ts";
import { builtinCardForms, type CardForm } from "../src/cli/watch-run-input.ts";
import { boardModel } from "./watch-board-fixture.ts";
import { realBrowser } from "./watch-real-browser.ts";

async function cardBoard(workflowId = "develop-prd", form?: CardForm) {
  const library = await readFile(new URL(import.meta.resolve("preact")));
  const page = pageDocument("a".repeat(64)).replace(
    /<link rel="stylesheet"[^>]*>/,
    "",
  );
  const model = {
    ...boardModel([], { workflows: [workflowId] }),
    cardForms: form === undefined ? builtinCardForms() : [form],
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
  ["develop-issue", {}, undefined],
  ["develop-prd", { ctrlKey: true }, undefined],
  ["develop-prd", { metaKey: true }, undefined],
  [
    "analyze-chats",
    {},
    {
      workflowId: "analyze-chats",
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
    await using board = await cardBoard(workflowId, form);
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
