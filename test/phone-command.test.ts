import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { phoneInvocation } from "../src/cli/phone-arguments.ts";
import { phoneRequest } from "../src/cli/phone-client.ts";
import { phoneCommand } from "../src/cli/phone-command.ts";
import { parsePhoneLink } from "../src/phone/phone-link.ts";
import { maximumFrameBytes } from "../src/protocol.ts";
import { startRelay } from "../src/relay/relay-service.ts";
import { withFiles } from "./quality/files-fixture.ts";

const state = { operation: "phone-state", parameters: {} };

async function fakeRelay(
  runtimeDirectory: string,
  line: string,
): Promise<net.Server> {
  await mkdir(runtimeDirectory, { recursive: true });
  const server = net.createServer((socket) => {
    socket.once("data", () => socket.end(line));
  });
  await new Promise<void>((ready) => {
    server.listen(join(runtimeDirectory, "phone.sock"), ready);
  });
  return server;
}

async function closed(server: net.Server): Promise<void> {
  await new Promise((settle) => server.close(settle));
}

async function command(
  runtimeDirectory: string | undefined,
  json: boolean,
): Promise<{ status: number; out: string; error: string }> {
  const output = { out: "", error: "" };
  const status = await phoneCommand(
    { kind: "phone", command: "status", json },
    {
      runtimeDirectory,
      terminal: {
        out: (text) => {
          output.out += text;
        },
        error: (text) => {
          output.error += text;
        },
      },
    },
  );
  return { status, ...output };
}

await test("CLV-187 phone status shows the registration and counts the phones", async () => {
  await withFiles({}, async (root) => {
    const runtimeDirectory = join(root, "run");
    const server = await fakeRelay(
      runtimeDirectory,
      `${JSON.stringify({ ok: true, result: { registered: true, daemonId: "dmn_1", origin: "https://cloving.ai", devices: [{ deviceId: "a" }] } })}\n`,
    );
    try {
      assert.deepEqual(await command(runtimeDirectory, false), {
        status: 0,
        out: "Registered as dmn_1 with https://cloving.ai. 1 phone.\n",
        error: "",
      });
    } finally {
      await closed(server);
    }
    const bare = await fakeRelay(
      runtimeDirectory,
      `${JSON.stringify({ ok: true, result: { registered: false } })}\n`,
    );
    try {
      assert.equal(
        (await command(runtimeDirectory, false)).out,
        "Not registered. 0 phones.\n",
      );
    } finally {
      await closed(bare);
    }
  });
});

await test("CLV-187 phone status reports a relay error and an unknown runtime directory", async () => {
  await withFiles({}, async (root) => {
    const runtimeDirectory = join(root, "run");
    const server = await fakeRelay(
      runtimeDirectory,
      `${JSON.stringify({ ok: false, error: { code: "phone-relay-failed", detail: "The store failed." } })}\n`,
    );
    try {
      assert.deepEqual(await command(runtimeDirectory, true), {
        status: 1,
        out: "",
        error: "phone-relay-failed: The store failed.\n",
      });
    } finally {
      await closed(server);
    }
    const unknown = await command(undefined, true);
    assert.equal(unknown.status, 1);
    assert.match(unknown.error, /^runtime-directory-unknown: /);
  });
});

await test("CLV-187 phoneRequest refuses a long path, ignores an event and reports a refused socket", async () => {
  await withFiles({}, async (root) => {
    const long = await phoneRequest(join(root, "x".repeat(120)), state);
    assert.equal(
      long?.kind === "error" ? long.error.code : "",
      "runtime-path-too-long",
    );
    const runtimeDirectory = join(root, "run");
    const server = await fakeRelay(
      runtimeDirectory,
      `${JSON.stringify({ event: { kind: "progress" } })}\n`,
    );
    try {
      assert.equal(await phoneRequest(runtimeDirectory, state), undefined);
      await chmod(join(runtimeDirectory, "phone.sock"), 0o000);
      await assert.rejects(phoneRequest(runtimeDirectory, state), {
        code: "EACCES",
      });
    } finally {
      await closed(server);
    }
  });
});

await test("CLV-187 the relay answers a failure for a broken link file and an oversized request", async () => {
  await withFiles({}, async (root) => {
    const runtimeDirectory = join(root, "run");
    const phoneDirectory = join(root, "state/phone");
    const relay = await startRelay({ runtimeDirectory, phoneDirectory });
    try {
      await writeFile(join(phoneDirectory, "link.json"), "{");
      const broken = await phoneRequest(runtimeDirectory, state);
      assert.equal(
        broken?.kind === "error" ? broken.error.code : "",
        "phone-relay-failed",
      );
      const oversized = await new Promise<string>((settle) => {
        const socket = net.connect(join(runtimeDirectory, "phone.sock"));
        let reply = "";
        socket.setEncoding("utf8");
        socket.on("data", (data: string) => {
          reply += data;
        });
        socket.once("end", () => {
          settle(reply);
        });
        socket.on("error", () => {
          settle(reply);
        });
        socket.write("x".repeat(maximumFrameBytes + 1));
      });
      assert.match(oversized, /"ok":false/);
    } finally {
      await relay.close();
    }
  });
});

await test("CLV-187 the link reader accepts only complete registrations", () => {
  assert.equal(parsePhoneLink(undefined), undefined);
  assert.equal(parsePhoneLink("null"), undefined);
  assert.equal(
    parsePhoneLink(JSON.stringify({ daemonId: "dmn_1" })),
    undefined,
  );
  assert.deepEqual(
    parsePhoneLink(
      JSON.stringify({
        daemonId: "dmn_1",
        origin: "https://cloving.ai",
        token: "t",
        registeredAt: "2026-10-25T12:00:00Z",
        extra: true,
      }),
    ),
    {
      daemonId: "dmn_1",
      origin: "https://cloving.ai",
      token: "t",
      registeredAt: "2026-10-25T12:00:00Z",
    },
  );
});

await test("CLV-187 the phone arguments accept status and refuse other forms", () => {
  assert.deepEqual(phoneInvocation(["status", "--json"]), {
    kind: "phone",
    command: "status",
    json: true,
  });
  assert.deepEqual(phoneInvocation(["-h"]), { kind: "phone-help" });
  for (const [argumentsList, code] of [
    [[], "missing-argument"],
    [["launch"], "unknown-command"],
    [["status", "extra"], "unexpected-argument"],
    [["status", "--port"], "unexpected-option"],
  ] as const)
    assert.deepEqual(phoneInvocation(argumentsList), {
      kind: "usage-error",
      code,
      json: false,
    });
});
