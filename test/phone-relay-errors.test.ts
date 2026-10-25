import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { phoneRequest } from "../src/cli/phone-client.ts";
import { canonicalJson } from "../src/phone/canonical-json.ts";
import { relayRequest } from "../src/relay/relay-http.ts";
import { startRelay } from "../src/relay/relay-service.ts";
import { withFiles } from "./quality/files-fixture.ts";

async function oddServer(
  answer: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ readonly origin: string; readonly close: () => Promise<void> }> {
  const server = createServer(answer);
  await new Promise<void>((ready) => {
    server.listen(0, "127.0.0.1", ready);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((settle) => server.close(settle));
    },
  };
}

function reply(status: number, body: unknown) {
  return (_: IncomingMessage, response: ServerResponse): void => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(typeof body === "string" ? body : JSON.stringify(body));
  };
}

async function startError(origin: string): Promise<string> {
  return withFiles({}, async (root) => {
    const runtimeDirectory = join(root, "run");
    const relay = await startRelay({
      runtimeDirectory,
      phoneDirectory: join(root, "state/phone"),
      origin,
      computerName: "Studio",
    });
    try {
      const answer = await phoneRequest(runtimeDirectory, {
        operation: "phone-pair-start",
        parameters: {},
      });
      return answer?.kind === "error" ? answer.error.detail : "";
    } finally {
      await relay.close();
    }
  });
}

await test("CLV-188 a refused or incomplete registration reports its cause", async () => {
  for (const [status, body, cause] of [
    [500, "not json", /registration-failed: cloving.ai answered 500/],
    [
      201,
      { daemon_id: "dmn_1" },
      /registration-invalid: cloving.ai sent no token/,
    ],
  ] as const) {
    const server = await oddServer(reply(status, body));
    try {
      assert.match(await startError(server.origin), cause);
    } finally {
      await server.close();
    }
  }
});

await test("CLV-188 a refused pairing or a pairing with no expiry reports its cause", async () => {
  for (const [status, body, cause] of [
    [500, null, /pairing-failed: cloving.ai answered 500/],
    [201, { stage: "open" }, /pairing-invalid: cloving.ai sent no expiry/],
  ] as const) {
    const server = await oddServer((request, response) => {
      if (request.url === "/api/v1/relay/daemons")
        reply(201, { daemon_id: "dmn_1", token: "t" })(request, response);
      else reply(status, body)(request, response);
    });
    try {
      assert.match(await startError(server.origin), cause);
    } finally {
      await server.close();
    }
  }
});

await test("CLV-188 a relay request ends after its time limit", async () => {
  const server = await oddServer(() => undefined);
  try {
    await assert.rejects(
      relayRequest(server.origin, {
        method: "GET",
        path: "/slow",
        timeoutMilliseconds: 50,
      }),
      /relay-timeout/,
    );
  } finally {
    await server.close();
  }
});

await test("CLV-188 the relay reports an unreadable link file", async () => {
  await withFiles({}, async (root) => {
    const runtimeDirectory = join(root, "run");
    const phoneDirectory = join(root, "state/phone");
    await mkdir(join(phoneDirectory, "link.json"), { recursive: true });
    const relay = await startRelay({ runtimeDirectory, phoneDirectory });
    try {
      const answer = await phoneRequest(runtimeDirectory, {
        operation: "phone-state",
        parameters: {},
      });
      assert.equal(
        answer?.kind === "error" ? answer.error.code : "",
        "phone-relay-failed",
      );
    } finally {
      await relay.close();
    }
  });
});

await test("CLV-188 canonical JSON sorts keys, keeps integers and refuses other numbers", () => {
  assert.equal(
    canonicalJson({ b: [1, true, null], a: "/é\u0001", c: { y: -2, x: "1" } }),
    '{"a":"/é\\u0001","b":[1,true,null],"c":{"x":"1","y":-2}}',
  );
  assert.throws(() => canonicalJson(1.5), /canonical-json-number/);
  assert.throws(() => canonicalJson(2 ** 60), /canonical-json-number/);
  assert.throws(() => canonicalJson(undefined), /canonical-json-value/);
});
