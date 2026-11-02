import assert from "node:assert/strict";
import { test } from "node:test";
import net from "node:net";
import { join } from "node:path";
import { startMcp, request } from "./mcp-fixture.ts";
import { fields, withHarness } from "./service-fixture.ts";
import { replyLine } from "../src/protocol.ts";

async function delayedService(runtime: string) {
  const received = Promise.withResolvers<net.Socket>();
  const server = net.createServer((socket) => {
    socket.once("data", () => {
      received.resolve(socket);
    });
  });
  await new Promise<void>((settle) =>
    server.listen(join(runtime, "control.sock"), settle),
  );
  return { server, received: received.promise };
}

const result = {
  schemaVersion: 1,
  kind: "event-page",
  events: [],
  latestSequence: 0,
};

await test("CLV-250 mcp drains a service call after stdin closes", () =>
  withHarness(async (harness) => {
    const service = await delayedService(harness.runtimeDirectory);
    const mcp = startMcp({ runtime: harness.runtimeDirectory });
    harness.cleanup(() => {
      mcp.child.kill();
      service.server.close();
    });
    mcp.send(
      request({
        id: 1,
        method: "tools/call",
        params: { name: "cloving_events" },
      }),
    );
    const socket = await service.received;
    const completed = mcp.end();
    socket.end(replyLine({ kind: "result", result }));
    const output = await completed;
    assert.equal(output.status, 0, output.stderr);
    assert.equal(mcp.messages.length, 1);
    assert.deepEqual(
      fields(mcp.messages[0]?.["result"])["structuredContent"],
      result,
    );
  }));

await test("CLV-250 mcp suppresses a cancelled call and continues with ping", () =>
  withHarness(async (harness) => {
    const service = await delayedService(harness.runtimeDirectory);
    const mcp = startMcp({ runtime: harness.runtimeDirectory });
    harness.cleanup(() => {
      mcp.child.kill();
      service.server.close();
    });
    mcp.send(
      request({
        id: "call",
        method: "tools/call",
        params: { name: "cloving_events" },
      }),
    );
    const socket = await service.received;
    mcp.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: "call", reason: "test" },
    });
    mcp.send(request({ id: 2, method: "ping" }));
    const completed = mcp.end();
    socket.end(replyLine({ kind: "result", result }));
    const output = await completed;
    assert.equal(output.status, 0, output.stderr);
    assert.deepEqual(mcp.messages, [{ jsonrpc: "2.0", id: 2, result: {} }]);
  }));

for (const name of ["cloving_status", "cloving_questions", "cloving_events"]) {
  await test(`CLV-250 mcp cancels ${name} when the service never replies`, () =>
    withHarness(async (harness) => {
      const service = await delayedService(harness.runtimeDirectory);
      const mcp = startMcp({ runtime: harness.runtimeDirectory });
      harness.cleanup(() => {
        mcp.child.kill();
        service.server.close();
      });
      mcp.send(request({ id: 1, method: "tools/call", params: { name } }));
      const socket = await service.received;
      harness.cleanup(() => {
        socket.destroy();
      });
      const closed = new Promise<void>((settle) => {
        socket.once("close", settle);
      });
      mcp.send({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 1 },
      });
      mcp.send(request({ id: "ping", method: "ping" }));
      const output = await mcp.end();
      assert.equal(output.status, 0, output.stderr);
      await closed;
      assert.deepEqual(mcp.messages, [
        { jsonrpc: "2.0", id: "ping", result: {} },
      ]);
    }));
}

await test("CLV-250 mcp ignores cancellations without a matching typed request ID", () =>
  withHarness(async (harness) => {
    const service = await delayedService(harness.runtimeDirectory);
    const mcp = startMcp({ runtime: harness.runtimeDirectory });
    harness.cleanup(() => {
      mcp.child.kill();
      service.server.close();
    });
    mcp.send(
      request({
        id: 1,
        method: "tools/call",
        params: { name: "cloving_events" },
      }),
    );
    const socket = await service.received;
    harness.cleanup(() => {
      socket.destroy();
    });
    for (const params of [{}, { requestId: {} }, { requestId: "1" }])
      mcp.send({ jsonrpc: "2.0", method: "notifications/cancelled", params });
    const ping = new Promise<void>((settle) => {
      mcp.child.stdout.once("data", () => {
        settle();
      });
    });
    mcp.send(request({ id: 2, method: "ping" }));
    await ping;
    socket.end(replyLine({ kind: "result", result }));
    const output = await mcp.end();
    assert.equal(output.status, 0, output.stderr);
    assert.deepEqual(mcp.messages, [
      { jsonrpc: "2.0", id: 2, result: {} },
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          structuredContent: result,
          content: [{ type: "text", text: JSON.stringify(result) }],
        },
      },
    ]);
  }));
