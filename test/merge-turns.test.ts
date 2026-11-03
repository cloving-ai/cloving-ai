import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as settled } from "node:timers/promises";
import { inMergeTurn } from "../src/daemon/merge-turns.ts";

function turn(
  repository: string,
  signal = new AbortController().signal,
): { readonly repository: string; readonly signal: AbortSignal } {
  return { repository, signal };
}

await test("CLV-280 merge turns of one repository run in request order", async () => {
  const order: string[] = [];
  const held = Promise.withResolvers<undefined>();
  const first = inMergeTurn(turn("/repositories/order"), async () => {
    order.push("first starts");
    await held.promise;
    order.push("first ends");
  });
  const second = inMergeTurn(turn("/repositories/order"), () => {
    order.push("second starts");
    return Promise.resolve();
  });
  await settled();
  assert.deepEqual(order, ["first starts"]);
  held.resolve(undefined);
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first starts", "first ends", "second starts"]);
});

await test("CLV-280 the next merge turn runs after a turn fails", async () => {
  const failed = inMergeTurn(turn("/repositories/release"), () =>
    Promise.reject(new Error("check-failed")),
  );
  const next = inMergeTurn(turn("/repositories/release"), () =>
    Promise.resolve("merged"),
  );
  await assert.rejects(failed, /check-failed/);
  assert.equal(await next, "merged");
});

await test("CLV-280 a step that aborts while it waits gives up its place", async () => {
  const held = Promise.withResolvers<undefined>();
  const ran: string[] = [];
  const first = inMergeTurn(turn("/repositories/abort"), () => held.promise);
  const controller = new AbortController();
  const waiting = inMergeTurn(
    turn("/repositories/abort", controller.signal),
    () => {
      ran.push("aborted step");
      return Promise.resolve();
    },
  );
  const third = inMergeTurn(turn("/repositories/abort"), () =>
    Promise.resolve("third"),
  );
  controller.abort(new Error("lease-lost"));
  await assert.rejects(waiting, /lease-lost/);
  held.resolve(undefined);
  await first;
  assert.equal(await third, "third");
  assert.deepEqual(ran, []);
});

await test("CLV-280 merge turns of different repositories do not wait for each other", async () => {
  const held = Promise.withResolvers<undefined>();
  const first = inMergeTurn(turn("/repositories/one"), () => held.promise);
  const other = await inMergeTurn(turn("/repositories/two"), () =>
    Promise.resolve("other"),
  );
  assert.equal(other, "other");
  held.resolve(undefined);
  await first;
});

await test("CLV-280 an abort without an Error reason gives merge-turn-aborted", async () => {
  const held = Promise.withResolvers<undefined>();
  const first = inMergeTurn(turn("/repositories/reason"), () => held.promise);
  const controller = new AbortController();
  const waiting = inMergeTurn(
    turn("/repositories/reason", controller.signal),
    () => Promise.resolve(),
  );
  controller.abort("stopped");
  await assert.rejects(waiting, /merge-turn-aborted/);
  held.resolve(undefined);
  await first;
});
