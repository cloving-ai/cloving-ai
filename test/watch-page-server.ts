import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import assert from "node:assert/strict";
import { pageDocument } from "../src/cli/watch-page.ts";

export async function watchPageServer(shown: unknown, hash: string) {
  const preact = await readFile(new URL(import.meta.resolve("preact")));
  const page = pageDocument().replace(/<link rel="stylesheet"[^>]*>/, "");
  const model = JSON.stringify(shown);
  const server = createServer((request, response) => {
    if (request.url === "/preact.mjs") {
      response
        .writeHead(200, { "content-type": "text/javascript" })
        .end(preact);
      return;
    }
    if (request.url === "/data.json") {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(model);
      return;
    }
    if (request.url === "/events") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: ready\n\n");
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
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      await server[Symbol.asyncDispose]();
    },
    url: `http://127.0.0.1:${String(address.port)}/${hash}`,
  };
}
