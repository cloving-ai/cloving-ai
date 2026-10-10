import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  authorityTiming,
  openAuthority,
} from "../src/broker/actor/authority.ts";
import { convertAuthority } from "../src/broker/actor/authority-conversion.ts";
import { executePinned, openedAuthority } from "./authority-actor-fixture.ts";
import { baselineDatabase } from "./authority-baseline-fixture.ts";
import { recorded } from "./authority-fixture.ts";
import {
  alterDatabase,
  queryDatabase,
  removeTemporaryDirectories,
  storedGate,
  temporaryDirectory,
} from "./authority-store-fixture.ts";

const admission = storedGate[0] ?? {};

function stalledFirstTurn(): (event: { readonly name: string }) => void {
  let started = 0;
  return (event) => {
    if (event.name !== "solid_objects.message.started") return;
    started += 1;
    if (started !== 1) return;
    const until = performance.now() + 400;
    while (performance.now() < until);
  };
}

await test("CLV-042 a malformed command is rejected by the reducer through the actor without a commit", async () => {
  const authority = await openedAuthority(await temporaryDirectory());
  assert.deepEqual(
    await authority.execute({ kind: "launch-run", runId: "run-1" }, recorded),
    { kind: "rejected", reason: "invalid-command" },
  );
  assert.equal((await authority.state()).sequence, 0);
  await authority.close();
});

await test("CLV-042 an authority opened without a delivery adapter refuses to run delivery", async () => {
  const authority = await openedAuthority(await temporaryDirectory());
  await assert.rejects(
    authority.deliver(new AbortController().signal),
    /delivery-unconfigured/,
  );
  await authority.close();
});

async function mismatchedSequence(
  statements: readonly string[],
): Promise<string> {
  const directory = await temporaryDirectory();
  const authority = await openedAuthority(directory);
  assert.equal((await executePinned(authority, admission)).kind, "accepted");
  await authority.close();
  for (const statement of [
    "UPDATE solid_instances SET state = json_set(state, '$.sequence', 0) WHERE actor_type = 'ClovingAuthority'",
    ...statements,
  ])
    alterDatabase(directory, statement);
  return directory;
}

async function refusedBeforeAnyTurn(directory: string): Promise<void> {
  const library = (): unknown => ({
    state: queryDatabase(
      directory,
      "SELECT state FROM solid_instances WHERE actor_type = 'ClovingAuthority'",
    ),
    messages: queryDatabase(
      directory,
      "SELECT count(*) AS count FROM solid_messages",
    ),
    deadLetters: queryDatabase(
      directory,
      "SELECT count(*) AS count FROM solid_dead_letters",
    ),
  });
  const before = library();
  for (let attempt = 0; attempt < 2; attempt += 1)
    assert.deepEqual(await openAuthority(directory), {
      kind: "refused",
      reason: "projection-mismatch",
      detail: "actor-sequence",
    });
  assert.deepEqual(library(), before);
}

await test("CLV-042 an actor sequence that differs from the event history is refused before any turn, also with a recoverable intent, and adds no message, dead letter or epoch", async () => {
  await refusedBeforeAnyTurn(await mismatchedSequence([]));
  await refusedBeforeAnyTurn(
    await mismatchedSequence(["UPDATE deliveries SET outcome = 'failed'"]),
  );
});

await test("CLV-042 an opening whose epoch turn loses its activation is refused and releases the authority, and the next opening applies the stranded turn once and leaves no message", async () => {
  const directory = await temporaryDirectory();
  await (await openedAuthority(directory)).close();
  const opening = await openAuthority(directory, {
    timing: {
      ...authorityTiming,
      leaseMilliseconds: 100,
      renewalMilliseconds: 30,
      heartbeatMilliseconds: 50,
      aliveThresholdMilliseconds: 300,
      cleanupIntervalMilliseconds: 100,
      callTimeoutMilliseconds: 600,
    },
    instrumentation: stalledFirstTurn(),
  });
  assert.equal(opening.kind, "refused");
  assert.equal(opening.reason, "authority-unavailable");
  assert.match(opening.detail, /timed out/);
  const reopened = await openedAuthority(directory);
  assert.equal((await reopened.state()).sequence, 0);
  assert.equal(reopened.epoch, 3);
  await reopened.close();
  assert.deepEqual(
    queryDatabase(
      directory,
      "SELECT operation FROM solid_messages WHERE completed_at_ms IS NULL",
    ),
    [],
  );
});

await test("CLV-042 conversion refuses a missing directory, an empty directory and an unreadable CLV-007 row", async () => {
  const parent = await temporaryDirectory();
  const missing = await convertAuthority(join(parent, "missing"));
  assert.equal(missing.kind, "refused");
  assert.equal(missing.reason, "storage-failure");
  const empty = join(parent, "empty");
  await mkdir(empty);
  assert.deepEqual(await convertAuthority(empty), {
    kind: "refused",
    reason: "nothing-to-convert",
    detail: "0",
  });
  const unreadable = join(parent, "unreadable");
  await mkdir(unreadable);
  baselineDatabase(unreadable, storedGate.slice(0, 2));
  alterDatabase(unreadable, "UPDATE runs SET revision = 9007199254740993");
  assert.deepEqual(await convertAuthority(unreadable), {
    kind: "refused",
    reason: "storage-failure",
    detail: "invalid-column: revision",
  });
});

await test("CLV-042 an opening or a conversion with an invalid timing is refused and releases the authority", async () => {
  const directory = await temporaryDirectory();
  const timing = {
    ...authorityTiming,
    leaseMilliseconds: 100,
    renewalMilliseconds: 200,
  };
  for (const attempt of [
    await openAuthority(directory, { timing }),
    await convertAuthority(directory, { timing }),
  ]) {
    assert.equal(attempt.kind, "refused");
    assert.equal(attempt.reason, "invalid-configuration");
    assert.match(attempt.detail, /leaseDurationMilliseconds/);
  }
  await (await openedAuthority(directory)).close();
});

await test("CLV-042 a second concurrent delivery run is refused and close still releases the authority", async () => {
  const directory = await temporaryDirectory();
  const authority = await openedAuthority(directory, {
    delivery: {
      deliver: () => Promise.resolve({ receipt: "receipt-1" }),
      reconcile: () => Promise.resolve({ kind: "absent" }),
    },
  });
  const controller = new AbortController();
  const running = authority.deliver(controller.signal);
  const second = authority.deliver(new AbortController().signal);
  try {
    await assert.rejects(second, /delivery-already-running/);
  } finally {
    controller.abort();
    await Promise.allSettled([running, second]);
  }
  await authority.close();
  await (await openedAuthority(directory)).close();
});

after(removeTemporaryDirectories);
