import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { record, replyLine } from "../src/protocol.ts";
import { heartbeat } from "../src/relay/relay-heartbeat.ts";
import { startRelay } from "../src/relay/relay-service.ts";
import { openRelayStore } from "../src/relay/relay-store.ts";
import {
  heartbeatContext,
  knownDevice,
  lostPhoneState,
} from "./phone-heartbeat-fixture.ts";
import {
  fakeRelayServer,
  registeredLink,
} from "./phone-relay-server-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";

await test("CLV-190 a registration-loss wait ignores a stale registered snapshot", () =>
  withFiles({}, async (root) => {
    const replies = [
      { registered: true, reason: "registration-lost" },
      { registered: false, reason: "registration-lost" },
    ];
    const server = createServer((socket) => {
      socket.once("data", () => {
        const state = replies.shift();
        assert.ok(state);
        socket.end(replyLine({ kind: "result", result: state }));
      });
    });
    await new Promise<void>((ready) => {
      server.listen(join(root, "phone.sock"), ready);
    });
    try {
      assert.equal((await lostPhoneState(root))["registered"], false);
      assert.deepEqual(replies, []);
    } finally {
      await new Promise((settle) => server.close(settle));
    }
  }));

await test("CLV-190 a 401 for a registration that a new registration replaced keeps the new one", async () => {
  await withFiles({}, async (root) => {
    const server = await fakeRelayServer({ heartbeatDelayMilliseconds: 300 });
    const phoneDirectory = join(root, "phone");
    await registeredLink(server, phoneDirectory);
    server.revoke("token-1");
    const store = await openRelayStore(phoneDirectory);
    try {
      await store.add(knownDevice);
      const stop = new AbortController();
      const beating = heartbeat(
        heartbeatContext(store, { phoneDirectory, waits: [], stop, count: 1 }),
      );
      await new Promise((settle) => setTimeout(settle, 100));
      await registeredLink(server, phoneDirectory);
      assert.equal(await beating, "replaced");
      const link: unknown = JSON.parse(
        await readFile(join(phoneDirectory, "link.json"), "utf8"),
      );
      assert.equal(record(link)?.["token"], "token-2");
      assert.equal((await store.devices())[0]?.removedAt, null);
    } finally {
      await store.close();
      await server.close();
    }
  });
});

await test("CLV-190 a cleanup that fails keeps the registration, so the next 401 runs the cleanup again", async () => {
  await withFiles({}, async (root) => {
    const server = await fakeRelayServer();
    const phoneDirectory = join(root, "phone");
    await registeredLink(server, phoneDirectory);
    server.revoke("token-1");
    const closed = await openRelayStore(phoneDirectory);
    await closed.close();
    const stop = new AbortController();
    try {
      await assert.rejects(
        heartbeat(
          heartbeatContext(closed, {
            phoneDirectory,
            waits: [],
            stop,
            count: 1,
          }),
        ),
      );
      await stat(join(phoneDirectory, "link.json"));
      const store = await openRelayStore(phoneDirectory);
      try {
        await store.add(knownDevice);
        assert.equal(
          await heartbeat(
            heartbeatContext(store, {
              phoneDirectory,
              waits: [],
              stop,
              count: 1,
            }),
          ),
          "lost",
        );
        assert.notEqual((await store.devices())[0]?.removedAt, null);
        await assert.rejects(stat(join(phoneDirectory, "link.json")), {
          code: "ENOENT",
        });
      } finally {
        await store.close();
      }
    } finally {
      await server.close();
    }
  });
});

await test("CLV-190 closing the relay does not wait for a slow heartbeat", async () => {
  await withFiles({}, async (root) => {
    const server = await fakeRelayServer({ heartbeatDelayMilliseconds: 5000 });
    const phoneDirectory = join(root, "state/phone");
    await registeredLink(server, phoneDirectory);
    const relay = await startRelay({
      runtimeDirectory: join(root, "run"),
      phoneDirectory,
      origin: server.origin,
      computerName: "Studio",
    });
    try {
      await new Promise((settle) => setTimeout(settle, 200));
      const started = Date.now();
      await relay.close();
      assert.ok(Date.now() - started < 2000, String(Date.now() - started));
    } finally {
      await server.close();
    }
  });
});
