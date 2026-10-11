import assert from "node:assert/strict";
import net from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { socketAddress } from "../src/broker/socket-address.ts";
import type { Service } from "../src/service/service.ts";
import {
  call,
  eventually,
  field,
  startedRun,
  testTiming,
  withHarness,
  type Harness,
} from "./service-fixture.ts";

interface Client {
  readonly socket: net.Socket;
  readonly lines: () => readonly string[];
  readonly closed: Promise<undefined>;
}

function connected(
  harness: Harness,
  options: { readonly allowHalfOpen: boolean },
): Client {
  const address = socketAddress(join(harness.runtimeDirectory, "control.sock"));
  if (address.kind !== "address") throw new Error(address.detail);
  const socket = net.connect({ path: address.path, ...options });
  let received = "";
  socket.on("data", (data) => {
    received += data.toString();
  });
  socket.on("error", () => undefined);
  return {
    socket,
    lines: () => received.split("\n").filter((line) => line.length > 0),
    closed: new Promise((settle) => {
      socket.on("close", () => {
        settle(undefined);
      });
    }),
  };
}

const follow = `${JSON.stringify({ protocol: 1, operation: "events", parameters: { after: 0, follow: true } })}\n`;
const closing = { allowHalfOpen: false };

async function backlog(harness: Harness, service: Service): Promise<number> {
  const runId = await startedRun(harness, { service, commandId: "c-1" });
  const reports = 300;
  for (let report = 0; report < reports; report += 1)
    await service.worker.observe({
      runId,
      commandId: `c-report-${String(report)}`,
      condition: "working",
      reason: "r".repeat(128),
      evidence: "e".repeat(128),
      operationId: "o".repeat(500),
    });
  return reports + 3;
}

await test("CLV-008 the service ends a connection that sends no complete request in the idle limit, and keeps a follower open", () =>
  withHarness(async (harness) => {
    const service = await harness.start({
      timing: { ...testTiming, idleMilliseconds: 150 },
    });
    const silent = connected(harness, closing);
    const partial = connected(harness, closing);
    partial.socket.write('{"protocol":1,"operation":"sta');
    const follower = connected(harness, closing);
    follower.socket.write(follow);
    const started = performance.now();
    await Promise.all([silent.closed, partial.closed]);
    assert.deepEqual([silent.lines(), partial.lines()], [[], []]);
    assert.ok(performance.now() - started < 3000);
    await delay(300);
    assert.equal(follower.socket.destroyed, false);
    follower.socket.destroy();
    const status = await call(harness, { operation: "status", parameters: {} });
    assert.equal(field(status, "kind"), "run-list");
    await service.close();
  }));

await test("CLV-008 a follower that reads gets each event of a backlog that is larger than the socket buffers, and it stays connected", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const total = await backlog(harness, service);
    const follower = connected(harness, closing);
    follower.socket.write(follow);
    await eventually(() =>
      follower.lines().length >= total ? true : undefined,
    );
    const sequences = follower
      .lines()
      .map((line) => field(field(JSON.parse(line), "event"), "sequence"));
    assert.deepEqual(
      sequences,
      Array.from({ length: total }, (_, index) => index + 1),
    );
    assert.ok(follower.lines().join("\n").length > 262_144);
    assert.equal(follower.socket.destroyed, false);
    follower.socket.destroy();
    await service.close();
  }));

await test("CLV-008 the service ends a follower that reads nothing for the idle limit while events wait for it", () =>
  withHarness(async (harness) => {
    const service = await harness.start({
      timing: { ...testTiming, idleMilliseconds: 300 },
    });
    const total = await backlog(harness, service);
    const follower = connected(harness, closing);
    follower.socket.pause();
    follower.socket.write(follow);
    await delay(1500);
    follower.socket.resume();
    const ended = await Promise.race([
      follower.closed.then(() => "closed"),
      delay(3000, "open"),
    ]);
    follower.socket.destroy();
    assert.equal(ended, "closed");
    assert.ok(follower.lines().length < total, String(follower.lines().length));
    const status = await call(harness, { operation: "status", parameters: {} });
    assert.equal(field(status, "kind"), "run-list");
    await service.close();
  }));

await test("CLV-008 the service ends a connection in the idle limit after its reply, also when the client keeps its side open", () =>
  withHarness(async (harness) => {
    const service = await harness.start({
      timing: { ...testTiming, idleMilliseconds: 150 },
    });
    const client = connected(harness, { allowHalfOpen: true });
    client.socket.write(
      `${JSON.stringify({ protocol: 1, operation: "status", parameters: {} })}\n`,
    );
    await eventually(() => (client.lines().length === 1 ? true : undefined));
    const refused = new Promise((settle) => {
      client.socket.once("error", () => {
        settle("refused");
      });
    });
    await delay(600);
    client.socket.write("more data after the reply\n");
    client.socket.write("and more\n");
    const outcome = await Promise.race([refused, delay(2000, "accepted")]);
    client.socket.destroy();
    assert.equal(outcome, "refused");
    await service.close();
  }));
