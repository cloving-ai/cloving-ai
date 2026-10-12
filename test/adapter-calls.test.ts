import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { adapterCalls } from "../src/broker/actor/adapter-calls.ts";

await test("CLV-049 an adapter call that replies before its time limit gives its reply, and its signal is not aborted after the limit", async () => {
  const calls = adapterCalls(30);
  const signals: AbortSignal[] = [];
  const result = await calls.call("operation-1", (signal) => {
    signals.push(signal);
    return Promise.resolve("the reply");
  });
  assert.deepEqual(result, { kind: "replied", reply: "the reply" });
  await delay(60);
  assert.deepEqual(
    signals.map((signal) => signal.aborted),
    [false],
  );
  const timers = (): number =>
    process.getActiveResourcesInfo().filter((name) => name === "Timeout")
      .length;
  const before = timers();
  await adapterCalls(60_000).call("operation-2", () => Promise.resolve(1));
  assert.equal(timers(), before);
});

await test("CLV-049 an adapter call that throws gives the message of its error", async () => {
  const calls = adapterCalls(30);
  assert.deepEqual(
    await calls.call("operation-1", () =>
      Promise.reject(new Error("the reply is lost")),
    ),
    { kind: "thrown", message: "the reply is lost" },
  );
  assert.deepEqual(
    await calls.call("operation-1", () => {
      throw new Error("a synchronous failure");
    }),
    { kind: "thrown", message: "a synchronous failure" },
  );
});

await test("CLV-049 an adapter call above its time limit is overdue, its signal is aborted, its late reply is ignored, and the operation gets no new call until the first call settles", async () => {
  const calls = adapterCalls(30);
  const held = Promise.withResolvers<string>();
  const signals: AbortSignal[] = [];
  const first = await calls.call("operation-1", (signal) => {
    signals.push(signal);
    return held.promise;
  });
  assert.deepEqual(first, { kind: "overdue" });
  assert.deepEqual(
    signals.map((signal) => signal.aborted),
    [true],
  );
  let invoked = 0;
  const invoke = (): Promise<string> => {
    invoked += 1;
    return Promise.resolve("a new reply");
  };
  assert.deepEqual(await calls.call("operation-1", invoke), {
    kind: "overdue",
  });
  assert.equal(invoked, 0);
  assert.deepEqual(await calls.call("operation-2", invoke), {
    kind: "replied",
    reply: "a new reply",
  });
  held.resolve("the late reply");
  await delay(0);
  assert.deepEqual(await calls.call("operation-1", invoke), {
    kind: "replied",
    reply: "a new reply",
  });
  assert.equal(invoked, 2);
});

await test("CLV-049 an overdue adapter call that rejects later causes no unhandled rejection and frees its operation", async () => {
  const calls = adapterCalls(20);
  const held = Promise.withResolvers<string>();
  assert.deepEqual(await calls.call("operation-1", () => held.promise), {
    kind: "overdue",
  });
  held.reject(new Error("a late failure"));
  await delay(0);
  assert.deepEqual(
    await calls.call("operation-1", () => Promise.resolve("a reply")),
    { kind: "replied", reply: "a reply" },
  );
});
