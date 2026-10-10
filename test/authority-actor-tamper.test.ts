import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { Authority } from "../src/broker/actor/authority.ts";
import { deliveryIntent } from "../src/broker/actor/turn-plan.ts";
import {
  deliverUntil,
  executePinned,
  externalService,
  openedAuthority,
} from "./authority-actor-fixture.ts";
import {
  alterDatabase,
  pin,
  removeTemporaryDirectories,
  storedGate,
  temporaryDirectory,
} from "./authority-store-fixture.ts";

const admission = storedGate[0] ?? {};
const intent = {
  kind: "start-run",
  runId: "run-1",
  operationId:
    '["cloving-operation",0,"run-1","admission","start-run",null,null]',
} as const;

async function admitted(directory: string): Promise<void> {
  const authority = await openedAuthority(directory);
  assert.equal((await executePinned(authority, admission)).kind, "accepted");
  await authority.close();
}

async function outcomes(authority: Authority): Promise<unknown> {
  return (await authority.operations()).map((operation) =>
    operation.deliveries.map((delivery) => [
      delivery.outcome,
      delivery.receipt,
    ]),
  );
}

async function deliveredAfterWithholding(directory: string): Promise<void> {
  const service = externalService();
  const authority = await openedAuthority(directory, service.options);
  await deliverUntil(
    authority,
    async () => (await authority.eligibleIntents()).length === 0,
  );
  assert.deepEqual(await outcomes(authority), [
    [
      ["withheld", null],
      ["sent", "receipt-1"],
    ],
  ]);
  assert.deepEqual(
    service.sent.map((sent) => [sent.runId, sent.workflow]),
    [["run-1", pin]],
  );
  await authority.close();
}

await test("CLV-042 a staged delivery whose arguments no longer match their input digest is withheld, and a correct delivery follows", async () => {
  const directory = await temporaryDirectory();
  await admitted(directory);
  alterDatabase(
    directory,
    "UPDATE solid_effects SET arguments = json_set(arguments, '$.runId', 'run-2')",
  );
  await deliveredAfterWithholding(directory);
});

await test("CLV-042 a staged delivery whose workflow differs from the run's pin is withheld even when its digest is consistent, and a correct delivery follows", async () => {
  const directory = await temporaryDirectory();
  await admitted(directory);
  const other = `${pin.slice(0, -1)}0`;
  const digest = deliveryIntent(intent, other).inputDigest;
  alterDatabase(
    directory,
    `UPDATE solid_effects SET arguments = json_set(arguments, '$.workflow', '${other}', '$.inputDigest', '${digest}'); UPDATE deliveries SET input_digest = '${digest}';`,
  );
  await deliveredAfterWithholding(directory);
});

after(removeTemporaryDirectories);
