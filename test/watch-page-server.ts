import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import assert from "node:assert/strict";
import { pageDocument } from "../src/cli/watch-page.ts";
import type { WatchModel } from "../src/cli/watch-render.ts";
import type { WatchThemes } from "../src/cli/watch-themes.ts";

interface PageFile {
  readonly type: string;
  readonly body: Uint8Array;
}

interface PageServerOptions {
  readonly hash?: string;
  readonly token?: string;
  readonly themes?: WatchThemes;
  readonly files?: Readonly<Record<string, PageFile>>;
  readonly actions?: Readonly<
    Record<string, { readonly reply: unknown; readonly next: WatchModel }>
  >;
}

function sendJson(response: ServerResponse, body: string): void {
  response.writeHead(200, { "content-type": "application/json" }).end(body);
}

function pageHandler(
  options: PageServerOptions,
  sources: {
    readonly shown: WatchModel;
    readonly page: string;
    readonly preact: Uint8Array;
  },
) {
  let model = JSON.stringify(sources.shown);
  const files: Partial<Record<string, PageFile>> = {
    "/preact.mjs": { type: "text/javascript", body: sources.preact },
    ...options.files,
  };
  return (request: IncomingMessage, response: ServerResponse) => {
    const path = request.url ?? "";
    const action =
      request.method === "POST" ? options.actions?.[path] : undefined;
    if (action !== undefined) {
      model = JSON.stringify(action.next);
      sendJson(response, JSON.stringify(action.reply));
      return;
    }
    const file = files[path];
    if (file !== undefined) {
      response.writeHead(200, { "content-type": file.type }).end(file.body);
      return;
    }
    if (path === "/data.json") {
      sendJson(response, model);
      return;
    }
    if (path === "/events") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: ready\n\n");
      return;
    }
    response
      .writeHead(200, {
        "content-type": "text/html",
        "content-security-policy": "default-src 'self' 'unsafe-inline' data:",
      })
      .end(sources.page);
  };
}

export async function watchPageServer(
  shown: WatchModel,
  options: PageServerOptions = {},
) {
  const preact = await readFile(new URL(import.meta.resolve("preact")));
  const page = pageDocument(options.token ?? null, options.themes);
  const server = createServer(pageHandler(options, { shown, page, preact }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return {
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      await server[Symbol.asyncDispose]();
    },
    url: `http://127.0.0.1:${String(address.port)}/${options.hash ?? ""}`,
  };
}
