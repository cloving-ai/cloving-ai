import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { phoneRequest } from "../src/cli/phone-client.ts";
import {
  parseRequest,
  replyLine,
  record,
  type ServiceRequest,
} from "../src/protocol.ts";
import { relayControl } from "../src/relay/relay-control.ts";
import {
  heartbeat,
  heartbeatTiming,
  runHeartbeats,
  type HeartbeatContext,
} from "../src/relay/relay-heartbeat.ts";
import { relayRequest } from "../src/relay/relay-http.ts";
import { startRelay } from "../src/relay/relay-service.ts";
import { openRelayStore, type RelayStore } from "../src/relay/relay-store.ts";
import {
  fakeRelayServer,
  type FakeRelayServer,
} from "./phone-relay-server-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";

async function registeredLink(
  server: FakeRelayServer,
  phoneDirectory: string,
): Promise<void> {
  const reply = await relayRequest(server.origin, {
    method: "POST",
    path: "/api/v1/relay/daemons",
    body: {},
  });
  await mkdir(phoneDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(phoneDirectory, "link.json"),
    JSON.stringify({
      daemonId: record(reply.body)?.["daemon_id"],
      origin: server.origin,
      token: record(reply.body)?.["token"],
      registeredAt: "2026-10-25T12:00:00Z",
    }),
    { mode: 0o600 },
  );
}

function context(
  store: RelayStore,
  settings: {
    readonly phoneDirectory: string;
    readonly waits: number[];
    readonly stop: AbortController;
    readonly count: number;
  },
): HeartbeatContext {
  return {
    phoneDirectory: settings.phoneDirectory,
    store,
    lost: () => undefined,
    timing: heartbeatTiming,
    wait: (milliseconds) => {
      settings.waits.push(milliseconds);
      if (settings.waits.length === settings.count) settings.stop.abort();
      return Promise.resolve();
    },
  };
}

function beats(server: FakeRelayServer): number {
  return server.requests.filter(
    (request) => request.path === "/api/v1/relay/daemon/heartbeat",
  ).length;
}

const device = {
  deviceId: "phone-1",
  name: "Pixel",
  platform: "android",
  agreementPublicKey: "a",
  answerPublicKey: "b",
  approvalPublicKey: "c",
  pairedAt: "2026-10-25T12:00:00Z",
  state: "connected" as const,
  removedAt: null,
};

await test("CLV-190 the relay beats at the interval while registered and backs off after failures", async () => {
  await withFiles({}, async (root) => {
    const server = await fakeRelayServer({
      heartbeatStatuses: [
        200, 500, 500, 500, 200, 500, 500, 500, 500, 500, 500, 500, 500,
      ],
    });
    const phoneDirectory = join(root, "phone");
    await registeredLink(server, phoneDirectory);
    const store = await openRelayStore(phoneDirectory);
    const waits: number[] = [];
    const stop = new AbortController();
    try {
      await runHeartbeats(
        context(store, { phoneDirectory, waits, stop, count: 14 }),
        stop.signal,
      );
    } finally {
      await store.close();
      await server.close();
    }
    assert.deepEqual(
      waits,
      [
        60_000, 5000, 10_000, 20_000, 60_000, 5000, 10_000, 20_000, 40_000,
        80_000, 160_000, 300_000, 300_000, 60_000,
      ],
    );
    assert.equal(beats(server), 14);
  });
});

await test("CLV-190 the relay sends no heartbeat without a registration", async () => {
  await withFiles({}, async (root) => {
    const server = await fakeRelayServer();
    const phoneDirectory = join(root, "phone");
    await mkdir(phoneDirectory, { recursive: true });
    const store = await openRelayStore(phoneDirectory);
    const waits: number[] = [];
    const stop = new AbortController();
    try {
      await runHeartbeats(
        context(store, { phoneDirectory, waits, stop, count: 3 }),
        stop.signal,
      );
    } finally {
      await store.close();
      await server.close();
    }
    assert.deepEqual(waits, [60_000, 60_000, 60_000]);
    assert.equal(server.requests.length, 0);
  });
});

await test("CLV-190 a revocation at cloving.ai writes a tombstone, and a device that only the server knows stays unknown", async () => {
  await withFiles({}, async (root) => {
    const server = await fakeRelayServer();
    const phoneDirectory = join(root, "phone");
    await registeredLink(server, phoneDirectory);
    const store = await openRelayStore(phoneDirectory);
    try {
      await store.add(device);
      server.list({ device_id: "phone-1", revoked_at: "2026-10-25T13:00:00Z" });
      server.list({ device_id: "phone-9", revoked_at: "2026-10-25T13:00:00Z" });
      server.list({ device_id: "phone-1", revoked_at: null });
      const stop = new AbortController();
      const outcome = await heartbeat(
        context(store, { phoneDirectory, waits: [], stop, count: 1 }),
      );
      assert.equal(outcome, "beat");
      const devices = await store.devices();
      assert.deepEqual(
        devices.map((item) => [item.deviceId, item.removedAt !== null]),
        [["phone-1", true]],
      );
    } finally {
      await store.close();
      await server.close();
    }
  });
});

await test("CLV-190 a 401 heartbeat removes the registration, writes tombstones and shows registration-lost", async () => {
  await withFiles({}, async (root) => {
    const server = await fakeRelayServer();
    const runtimeDirectory = join(root, "run");
    const phoneDirectory = join(root, "state/phone");
    await registeredLink(server, phoneDirectory);
    const relay = await startRelay({
      runtimeDirectory,
      phoneDirectory,
      origin: server.origin,
      computerName: "Studio",
      heartbeatTiming: {
        intervalMilliseconds: 30,
        firstBackoffMilliseconds: 30,
        longestBackoffMilliseconds: 30,
      },
    });
    try {
      server.revoke("token-1");
      let state: Readonly<Record<string, unknown>> = {};
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const reply = await phoneRequest(runtimeDirectory, {
          operation: "phone-state",
          parameters: {},
        });
        state = reply?.kind === "result" ? reply.result : {};
        if (state["reason"] === "registration-lost") break;
        await new Promise((settle) => setTimeout(settle, 20));
      }
      assert.equal(state["registered"], false);
      assert.equal(state["reason"], "registration-lost");
      await assert.rejects(stat(join(phoneDirectory, "link.json")), {
        code: "ENOENT",
      });
    } finally {
      await relay.close();
      await server.close();
    }
  });
});

await test("CLV-190 the relay control client refuses run and run-command before the socket", async () => {
  await withFiles({}, async (root) => {
    const received: ServiceRequest[] = [];
    const server = createServer((socket) => {
      socket.once("data", (data: Buffer) => {
        const parsed = parseRequest(data.toString().trim());
        if (parsed.kind === "request") received.push(parsed.request);
        socket.end(replyLine({ kind: "result", result: { questions: [] } }));
      });
    });
    await new Promise<void>((ready) => {
      server.listen(join(root, "control.sock"), ready);
    });
    try {
      const send = relayControl(root);
      for (const operation of ["run", "run-command", "approve"])
        await assert.rejects(send({ operation, parameters: {} }), {
          message: /^relay-operation-refused: /,
        });
      assert.equal(received.length, 0);
      const reply = await send({ operation: "questions", parameters: {} });
      assert.deepEqual(reply, { kind: "result", result: { questions: [] } });
      assert.deepEqual(
        received.map((request) => request.operation),
        ["questions"],
      );
    } finally {
      await new Promise((settle) => server.close(settle));
    }
  });
});

await test("CLV-190 an unreachable server counts as a failed beat", async () => {
  await withFiles({}, async (root) => {
    const phoneDirectory = join(root, "phone");
    await mkdir(phoneDirectory, { recursive: true });
    await writeFile(
      join(phoneDirectory, "link.json"),
      JSON.stringify({
        daemonId: "dmn_1",
        origin: "http://127.0.0.1:9",
        token: "t",
        registeredAt: "2026-10-25T12:00:00Z",
      }),
    );
    const store = await openRelayStore(phoneDirectory);
    try {
      const stop = new AbortController();
      assert.equal(
        await heartbeat(
          context(store, { phoneDirectory, waits: [], stop, count: 1 }),
        ),
        "failed",
      );
    } finally {
      await store.close();
    }
  });
});

await test("CLV-190 a failing store during the revocations keeps the beat", async () => {
  await withFiles({}, async (root) => {
    const phoneDirectory = join(root, "phone");
    const server = await fakeRelayServer();
    await registeredLink(server, phoneDirectory);
    const closed = await openRelayStore(phoneDirectory);
    await closed.close();
    try {
      const stop = new AbortController();
      assert.equal(
        await heartbeat(
          context(closed, { phoneDirectory, waits: [], stop, count: 1 }),
        ),
        "beat",
      );
    } finally {
      await server.close();
    }
  });
});

await test("CLV-190 a broken link file counts as a failed beat, and a stopped loop does not beat", async () => {
  await withFiles({}, async (root) => {
    const broken = join(root, "broken");
    await mkdir(join(broken, "link.json"), { recursive: true });
    const waits: number[] = [];
    const store = await openRelayStore(broken);
    try {
      const stopped = new AbortController();
      stopped.abort();
      await runHeartbeats(
        context(store, {
          phoneDirectory: broken,
          waits,
          stop: stopped,
          count: 1,
        }),
        stopped.signal,
      );
      const ended = new AbortController();
      await runHeartbeats(
        context(store, {
          phoneDirectory: broken,
          waits,
          stop: ended,
          count: 1,
        }),
        ended.signal,
      );
    } finally {
      await store.close();
    }
    assert.deepEqual(waits, [5000]);
  });
});
