import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { test } from "node:test";
import { pageDocument } from "../src/cli/watch-page.ts";
import { qrMatrix } from "../src/phone/qr-matrix.ts";
import { qrPicture } from "../src/phone/qr-picture.ts";
import { boardModel } from "./watch-board-fixture.ts";
import { realBrowser } from "./watch-real-browser.ts";

const link =
  "https://cloving.ai/pair#v1.AAECAwQFBgcICQoLDA0ODz_m_vaS7vPj4dzHYbgRwJw";

interface Served {
  readonly type: string;
  readonly body: string | Uint8Array;
}

function phoneReply(path: string, lifetimeMilliseconds: number): unknown {
  if (path === "/phone.json")
    return { relay: "on", registered: true, pairing: null, devices: [] };
  if (path !== "/actions/phone/pair") return { pairing: null };
  return {
    link,
    expiresAt: new Date(Date.now() + lifetimeMilliseconds).toISOString(),
    picture: qrPicture(qrMatrix(link).modules),
  };
}

async function phoneBoard(lifetimeMilliseconds: number) {
  const library = await readFile(new URL(import.meta.resolve("preact")));
  const model = JSON.stringify(
    boardModel([], { workflows: ["develop-issue"] }),
  );
  const actions: string[] = [];
  const served = (path: string): Served => {
    if (path === "/preact.mjs")
      return { type: "text/javascript", body: library };
    if (path === "/data.json") return { type: "application/json", body: model };
    if (path.startsWith("/actions/phone/")) actions.push(path);
    if (path === "/phone.json" || path.startsWith("/actions/phone/"))
      return {
        type: "application/json",
        body: JSON.stringify(phoneReply(path, lifetimeMilliseconds)),
      };
    return { type: "text/html", body: pageDocument("a".repeat(64)) };
  };
  const server = createServer((request, response) => {
    if (request.url === "/events") {
      response
        .writeHead(200, { "content-type": "text/event-stream" })
        .write("data: ready\n\n");
      return;
    }
    const reply = served(String(request.url));
    response.writeHead(200, { "content-type": reply.type }).end(reply.body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return {
    actions,
    url: `http://127.0.0.1:${String(address.port)}/#workflow=develop-issue`,
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      await server[Symbol.asyncDispose]();
    },
  };
}

const helpers = `
const until = (check, label) => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => { clearInterval(timer); reject(new Error(label)); }, 8000);
  const timer = setInterval(() => {
    const found = check();
    if (!found) return;
    clearInterval(timer); clearTimeout(timeout); resolve(found);
  }, 20);
});
const button = (text) => [...document.querySelectorAll("button")].find((item) => item.textContent === text);
const code = () => document.querySelector("svg.phone-qr");
`;

await test("CLV-188 Connect a phone shows the QR code, and Cancel removes it", async () => {
  await using board = await phoneBoard(600_000);
  await using browser = await realBrowser();
  const page = await browser.page({ width: 900, height: 800 });
  await page.navigate(board.url);
  const result = await page.evaluate(`(async () => {
    ${helpers}
    (await until(() => button("Connect a phone"), "no connect button")).click();
    const shown = await until(code, "no QR code");
    const text = document.querySelector(".phone").textContent;
    const box = shown.getAttribute("viewBox");
    button("Cancel").click();
    await until(() => !code() && button("Connect a phone"), "QR code stays after Cancel");
    return { text, box };
  })()`);
  assert.match(String(result["text"]), /Scan with your phone camera/);
  assert.match(String(result["text"]), /\d+:\d\d left/);
  assert.equal(result["box"], "0 0 45 45");
  assert.deepEqual(board.actions, [
    "/actions/phone/pair",
    "/actions/phone/cancel",
  ]);
});

await test("CLV-188 the QR code goes away at the expiry, and the button comes back", async () => {
  await using board = await phoneBoard(1500);
  await using browser = await realBrowser();
  const page = await browser.page({ width: 900, height: 800 });
  await page.navigate(board.url);
  const result = await page.evaluate(`(async () => {
    ${helpers}
    (await until(() => button("Connect a phone"), "no connect button")).click();
    await until(code, "no QR code");
    await until(() => !code() && button("Connect a phone"), "QR code stays after the expiry");
    return { ended: true };
  })()`);
  assert.equal(result["ended"], true);
  assert.deepEqual(board.actions, ["/actions/phone/pair"]);
});
