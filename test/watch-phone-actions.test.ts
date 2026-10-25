import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import {
  parseRequest,
  replyLine,
  type Reply,
  type ServiceRequest,
} from "../src/protocol.ts";
import { actionHeaders, pageToken } from "./watch-action-fixture.ts";
import type { Watching } from "./watch-fixture.ts";
import { withWatchService } from "./watch-service-fixture.ts";

const link =
  "https://cloving.ai/pair#v1.AAECAwQFBgcICQoLDA0ODz_m_vaS7vPj4dzHYbgRwJw";

async function fakePhoneRelay(
  runtimeDirectory: string,
  answer: (request: ServiceRequest) => Reply,
): Promise<Server> {
  const server = createServer((socket) => {
    let buffered = "";
    socket.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      if (!buffered.includes("\n")) return;
      const parsed = parseRequest(buffered.trim());
      assert.equal(parsed.kind, "request");
      socket.end(replyLine(answer(parsed.request)));
    });
  });
  await new Promise<void>((ready) => {
    server.listen(join(runtimeDirectory, "phone.sock"), ready);
  });
  return server;
}

function post(
  watch: Watching,
  exchange: {
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
  },
): Promise<{ readonly status: number | undefined; readonly body: string }> {
  return new Promise((settle, reject) => {
    const sent = httpRequest(
      new URL(exchange.path, watch.address),
      { method: "POST", headers: exchange.headers },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          settle({ status: response.statusCode, body });
        });
      },
    );
    sent.on("error", reject);
    sent.end("{}");
  });
}

async function assertRefused(
  watch: Watching,
  good: Readonly<Record<string, string>>,
): Promise<void> {
  for (const headers of [
    { ...good, "x-cloving-token": "b".repeat(64) },
    { ...good, origin: "http://evil.example" },
    { ...good, host: "evil.example:3663" },
    { ...good, "content-type": "text/plain" },
  ]) {
    const reply = await post(watch, { path: "actions/phone/pair", headers });
    assert.equal(reply.status, 403, JSON.stringify(headers));
  }
}

const service = (): Reply => ({
  kind: "result",
  result: { runs: [], workflows: [] },
});

await test("CLV-188 phone actions without the page token, from another origin or from another host are refused, and no pairing starts", () =>
  withWatchService(service, async (watch, runtimeDirectory) => {
    const requests: ServiceRequest[] = [];
    const relay = await fakePhoneRelay(runtimeDirectory, (request) => {
      requests.push(request);
      return {
        kind: "result",
        result: { link, expiresAt: "2026-10-25T12:10:00Z" },
      };
    });
    try {
      const token = await pageToken(watch);
      const good = actionHeaders(watch, token);
      await assertRefused(watch, good);
      assert.equal(requests.length, 0);
      const started = await post(watch, {
        path: "actions/phone/pair",
        headers: good,
      });
      assert.equal(started.status, 200);
      const body: unknown = JSON.parse(started.body);
      assert.equal(Reflect.get(Object(body), "link"), link);
      assert.equal(
        Reflect.get(Object(body), "expiresAt"),
        "2026-10-25T12:10:00Z",
      );
      const picture: unknown = Reflect.get(Object(body), "picture");
      assert.equal(Reflect.get(Object(picture), "size"), 45);
      assert.match(
        String(Reflect.get(Object(picture), "path")),
        /^M4 4h7v1h-7z/,
      );
      const cancelled = await post(watch, {
        path: "actions/phone/cancel",
        headers: good,
      });
      assert.equal(cancelled.status, 200);
      assert.equal(
        (await post(watch, { path: "actions/phone/launch", headers: good }))
          .status,
        404,
      );
      assert.deepEqual(
        requests.map((request) => request.operation),
        ["phone-pair-start", "phone-pair-cancel"],
      );
    } finally {
      await new Promise((settle) => relay.close(settle));
    }
  }));

await test("CLV-188 phone.json shows the phone state, or that the relay is off", () =>
  withWatchService(service, async (watch, runtimeDirectory) => {
    const off = await fetch(`${watch.address}phone.json`);
    assert.deepEqual(await off.json(), { relay: "off" });
    const relay = await fakePhoneRelay(runtimeDirectory, () => ({
      kind: "result",
      result: { registered: false, pairing: null, devices: [] },
    }));
    try {
      const on = await fetch(`${watch.address}phone.json`);
      assert.deepEqual(await on.json(), {
        relay: "on",
        registered: false,
        pairing: null,
        devices: [],
      });
      const token = await pageToken(watch);
      const offAction = await post(watch, {
        path: "actions/phone/pair",
        headers: actionHeaders(watch, token),
      });
      assert.equal(offAction.status, 200);
    } finally {
      await new Promise((settle) => relay.close(settle));
    }
  }));
