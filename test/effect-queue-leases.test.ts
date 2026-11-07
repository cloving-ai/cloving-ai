import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import type { Authority } from "../src/broker/actor/authority.ts";
import { pinnedIdentity } from "../src/execution-pin.ts";
import { openedAuthority } from "./authority-actor-fixture.ts";
import {
  manifest,
  removeTemporaryDirectories,
  storedGate,
  temporaryDirectory,
} from "./authority-store-fixture.ts";
import { effectRequest, noon } from "./effect-fixture.ts";

after(removeTemporaryDirectories);

const queueManifest = { ...manifest, queue: true };
const queuePin = `sha256:${createHash("sha256").update(pinnedIdentity(queueManifest)).digest("hex")}`;

async function started(
  authority: Authority,
  run: { readonly runId: string; readonly queue: boolean },
): Promise<void> {
  const { runId, queue } = run;
  const recorded = { recordedAt: noon, epoch: authority.epoch, documents: [] };
  const admitted = await authority.execute(
    {
      ...storedGate[0],
      runId,
      commandId: `c-admitted-${runId}`,
      effectLimit: 5,
      capabilities: JSON.stringify([...manifest.capabilities].sort()),
      ...(queue ? { workflow: queuePin } : {}),
    },
    { ...recorded, manifest: queue ? queueManifest : manifest },
  );
  assert.equal(admitted.kind, "accepted", JSON.stringify(admitted));
  const marked = await authority.execute(
    {
      kind: "mark-started",
      commandId: `c-started-${runId}`,
      runId,
      expectedRevision: 1,
    },
    recorded,
  );
  assert.equal(marked.kind, "accepted", JSON.stringify(marked));
}

async function requested(
  authority: Authority,
  run: { readonly runId: string; readonly queue: boolean },
): Promise<void> {
  await started(authority, run);
  const request = effectRequest({
    commandId: `c-request-${run.runId}`,
    round: 1,
    runId: run.runId,
  });
  const receipt = await authority.execute(request.command, {
    recordedAt: noon,
    epoch: authority.epoch,
    documents: request.documents,
  });
  assert.equal(receipt.kind, "accepted", JSON.stringify(receipt));
}

const runIds = ["q-1", "q-2", "q-3", "q-4", "q-5", "q-6", "q-7", "s-1", "s-2"];

async function statuses(
  authority: Authority,
): Promise<Readonly<Record<string, string>>> {
  const entries: [string, string][] = [];
  for (const runId of runIds)
    for (const operation of await authority.effects.operations(runId))
      entries.push([runId, operation.status]);
  return Object.fromEntries(entries);
}

async function grantedLimits(
  authority: Authority,
): Promise<Readonly<Record<string, string | null>>> {
  return Object.fromEntries(
    (await authority.events())
      .filter((event) => event.type === "lease.granted")
      .map((event) => [event.runId, event.payload["queueLimit"] ?? null]),
  );
}

await test("CLV-322 with 4 lanes and a reserve of 2, four queue runs hold four leases, a fifth queue run waits and a scheduled run gets a lease", async () => {
  const directory = await temporaryDirectory();
  const authority = await openedAuthority(directory, {
    leaseLimits: () => ({ capacity: 6, queueLimit: 4 }),
  });
  for (const runId of ["q-1", "q-2", "q-3", "q-4", "q-5"])
    await requested(authority, { runId, queue: true });
  await requested(authority, { runId: "s-1", queue: false });
  assert.deepEqual(await statuses(authority), {
    "q-1": "dispatch-pending",
    "q-2": "dispatch-pending",
    "q-3": "dispatch-pending",
    "q-4": "dispatch-pending",
    "q-5": "waiting",
    "s-1": "dispatch-pending",
  });
  assert.deepEqual(await grantedLimits(authority), {
    "q-1": "4",
    "q-2": "4",
    "q-3": "4",
    "q-4": "4",
    "s-1": null,
  });
  await authority.close();
});

await test("CLV-322 with 2 lanes and a reserve of 2 a third queue run waits while two queue runs hold leases, and with 6 lanes six queue runs hold six leases", async () => {
  const narrow = await openedAuthority(await temporaryDirectory(), {
    leaseLimits: () => ({ capacity: 4, queueLimit: 2 }),
  });
  for (const runId of ["q-1", "q-2", "q-3"])
    await requested(narrow, { runId, queue: true });
  assert.deepEqual(await statuses(narrow), {
    "q-1": "dispatch-pending",
    "q-2": "dispatch-pending",
    "q-3": "waiting",
  });
  await narrow.close();
  const wide = await openedAuthority(await temporaryDirectory(), {
    leaseLimits: () => ({ capacity: 8, queueLimit: 6 }),
  });
  for (const runId of ["q-1", "q-2", "q-3", "q-4", "q-5", "q-6", "q-7"])
    await requested(wide, { runId, queue: true });
  assert.deepEqual(Object.values(await statuses(wide)), [
    ...Array.from({ length: 6 }, () => "dispatch-pending"),
    "waiting",
  ]);
  await wide.close();
});

await test("CLV-322 a raised queue limit applies at the next turn and grants a lease to the waiting queue run", async () => {
  let limits = { capacity: 6, queueLimit: 4 };
  const authority = await openedAuthority(await temporaryDirectory(), {
    leaseLimits: () => limits,
  });
  for (const runId of ["q-1", "q-2", "q-3", "q-4", "q-5"])
    await requested(authority, { runId, queue: true });
  assert.equal((await statuses(authority))["q-5"], "waiting");
  limits = { capacity: 7, queueLimit: 5 };
  await requested(authority, { runId: "s-1", queue: false });
  assert.deepEqual(await grantedLimits(authority), {
    "q-1": "4",
    "q-2": "4",
    "q-3": "4",
    "q-4": "4",
    "s-1": null,
    "q-5": "5",
  });
  await authority.close();
});
