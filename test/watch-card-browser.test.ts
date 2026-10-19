import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { test } from "node:test";
import { pageDocument } from "../src/cli/watch-page.ts";
import { builtinCardForms } from "../src/cli/watch-run-input.ts";
import { boardModel } from "./watch-board-fixture.ts";
import { realBrowser } from "./watch-real-browser.ts";

async function cardBoard() {
  const library = await readFile(new URL(import.meta.resolve("preact")));
  const page = pageDocument("a".repeat(64)).replace(
    /<link rel="stylesheet"[^>]*>/,
    "",
  );
  const model = {
    ...boardModel([], { workflows: ["develop-prd"] }),
    cardForms: builtinCardForms(),
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
    url: `http://127.0.0.1:${String(address.port)}/#workflow=develop-prd`,
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
