import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";
import {
  authorityTiming,
  type AuthorityOptions,
} from "../src/broker/actor/authority.ts";
import {
  deliverUntil,
  executePinned,
  externalService,
  openedAuthority,
  quickCleanupTiming,
} from "./authority-actor-fixture.ts";
import {
  removeTemporaryDirectories,
  storedGate,
  temporaryDirectory,
  withChild,
} from "./authority-store-fixture.ts";

const admission = storedGate[0] ?? {};
const start = {
  kind: "start-run",
  runId: "run-1",
  operationId:
    '["cloving-operation",0,"run-1","admission","start-run",null,null]',
};
const timing = {
  ...authorityTiming,
  leaseMilliseconds: 100,
  renewalMilliseconds: 30,
  heartbeatMilliseconds: 50,
  aliveThresholdMilliseconds: 300,
  cleanupIntervalMilliseconds: 100,
  callTimeoutMilliseconds: 600,
};

function stalledTurn(
  operation: string,
): Pick<AuthorityOptions, "instrumentation"> {
  let stalled = false;
  return {
    instrumentation: (event) => {
      if (event.name !== "solid_objects.message.started") return;
      if (stalled || event.attributes["operation"] !== operation) return;
      stalled = true;
      const until = performance.now() + 400;
      while (performance.now() < until);
    },
  };
}

await test("CLV-008 a command whose turn loses its activation is reported as a stranded message after the call timeout, and a restart commits it exactly once", async () => {
  const directory = await temporaryDirectory();
  const authority = await openedAuthority(directory, {
    timing,
    ...stalledTurn("execute"),
  });
  const receipt = await executePinned(authority, admission);
  assert.equal(receipt.kind, "failed");
  assert.equal(receipt.reason, "authority-unavailable");
  assert.match(
    receipt.detail,
    /^SyncTimeout: .* status=claimed waitingOn=messageClaimed$/,
  );
  await delay(timing.callTimeoutMilliseconds);
  const after = await executePinned(authority, admission);
  assert.equal(after.kind, "failed");
  assert.equal(after.reason, "storage-unavailable");
  assert.match(after.detail, /^closed after stranded message [0-9a-f-]{36}$/);
  await assert.rejects(
    authority.state(),
    /^Error: authority-unavailable: stranded message [0-9a-f-]{36}$/,
  );
  await authority.close();
  const restarted = await openedAuthority(directory);
  assert.deepEqual(
    (await restarted.events()).map((event) => event.commandId),
    ["c-1"],
  );
  assert.deepEqual(await executePinned(restarted, admission), {
    kind: "duplicate",
    sequence: 1,
    intents: [start],
  });
  await restarted.close();
});

await test("CLV-042 a delivery callback that loses its activation and stays claimed fails the authority closed within the bound, and a restart applies it exactly once", async () => {
  const directory = await temporaryDirectory();
  const service = externalService();
  const authority = await openedAuthority(directory, {
    ...service.options,
    timing,
    ...stalledTurn("deliveryCompleted"),
  });
  assert.equal((await executePinned(authority, admission)).kind, "accepted");
  const started = performance.now();
  const controller = new AbortController();
  const outcome = await Promise.race([
    authority.deliver(controller.signal).then(
      () => "stopped",
      (error: unknown) => String(error),
    ),
    delay(5_000, "not detected", { ref: false }),
  ]);
  controller.abort();
  assert.match(outcome, /authority-unavailable: stranded message /);
  assert.ok(performance.now() - started < 4_000);
  await assert.rejects(authority.state(), /authority-unavailable/);
  await authority.close();
  const restarted = await openedAuthority(directory, service.options);
  await deliverUntil(
    restarted,
    async () => (await restarted.eligibleIntents()).length === 0,
  );
  assert.equal(service.sent.length, 1);
  assert.deepEqual(
    (await restarted.events()).map((event) => event.type),
    ["run.created", "step.dispatched"],
  );
  await restarted.close();
});

await test("CLV-042 a command stranded by a process that then dies is committed exactly once by the next opening in a new process", async () => {
  const directory = await temporaryDirectory();
  await withChild(
    { script: "authority-actor-child.ts", parameters: [directory, "strand"] },
    async (child) => {
      await child.waitFor("activation-lost");
      assert.deepEqual(await child.kill(), { code: null, signal: "SIGKILL" });
    },
  );
  const started = performance.now();
  const authority = await openedAuthority(directory, {
    timing: quickCleanupTiming,
  });
  assert.ok(performance.now() - started < 8_000);
  assert.deepEqual(
    (await authority.events()).map((event) => event.commandId),
    ["c-1"],
  );
  assert.deepEqual(await executePinned(authority, admission), {
    kind: "duplicate",
    sequence: 1,
    intents: [start],
  });
  await authority.close();
});

after(removeTemporaryDirectories);
