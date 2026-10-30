import assert from "node:assert/strict";
import { after, test } from "node:test";
import { openAuthority } from "../src/broker/actor/authority.ts";
import { convertAuthority } from "../src/broker/actor/authority-conversion.ts";
import {
  deliverUntil,
  executePinned,
  externalService,
  fastTiming,
  openedAuthority,
} from "./authority-actor-fixture.ts";
import {
  baselineDatabase,
  type Baseline,
} from "./authority-baseline-fixture.ts";
import { continuation, storedParts } from "./authority-fixture.ts";
import {
  alterDatabase,
  manifest,
  pin,
  queryDatabase,
  removeTemporaryDirectories,
  storedGate,
  temporaryDirectory,
  withChild,
} from "./authority-store-fixture.ts";

const secondRun = {
  kind: "admit-run",
  commandId: "c-5",
  runId: "run-2",
  workflow: pin,
};
const records = [...storedGate, secondRun];
const converted = { kind: "converted", sequence: 5, staged: 2 };

function start(runId: string): Readonly<Record<string, string>> {
  return {
    kind: "start-run",
    runId,
    operationId: `["cloving-operation",0,"${runId}","admission","start-run",null,null]`,
  };
}

async function baseline(): Promise<{
  readonly directory: string;
  readonly records: Baseline;
}> {
  const directory = await temporaryDirectory();
  return { directory, records: baselineDatabase(directory, records) };
}

async function assertConverted(
  directory: string,
  expected: Baseline,
): Promise<void> {
  const service = externalService();
  const authority = await openedAuthority(directory, service.options);
  assert.deepEqual(await authority.state(), storedParts(expected.state));
  assert.deepEqual(await authority.events(), expected.events);
  assert.equal((await authority.settings()).schemaVersion, 7);
  assert.deepEqual(await authority.resumePinned("run-1", manifest), {
    kind: "admitted",
    manifest,
  });
  assert.deepEqual(await executePinned(authority, storedGate[3] ?? {}), {
    kind: "duplicate",
    sequence: 4,
    intents: [continuation],
  });
  assert.deepEqual(
    (await authority.operations()).map((operation) => [
      operation.operationId,
      operation.releasedSequence,
      operation.deliveries.map((delivery) => delivery.outcome),
    ]),
    [
      [start("run-1")["operationId"], 2, []],
      [continuation.operationId, null, [null]],
      [start("run-2")["operationId"], null, [null]],
    ],
  );
  await deliverUntil(
    authority,
    async () => (await authority.eligibleIntents()).length === 0,
  );
  assert.deepEqual(
    service.sent.map((intent) => intent.operationId).sort(),
    [continuation.operationId, start("run-2")["operationId"]].sort(),
  );
  await authority.close();
}

await test("CLV-042 an opening refuses a stopped CLV-007 database until it is converted", async () => {
  const { directory } = await baseline();
  assert.deepEqual(await openAuthority(directory), {
    kind: "refused",
    reason: "conversion-required",
    detail: "schema version 1",
  });
});

await test("CLV-042 conversion keeps the CLV-007 records, pins, receipts and pending operation identities, stages eligible intents without a send, and is idempotent", async () => {
  const { directory, records: expected } = await baseline();
  assert.deepEqual(await convertAuthority(directory), converted);
  assert.deepEqual(await convertAuthority(directory), {
    ...converted,
    staged: 0,
  });
  await assertConverted(directory, expected);
});

await test("CLV-042 conversion refuses a CLV-007 database whose projections differ from its history and leaves it unchanged", async () => {
  const { directory } = await baseline();
  alterDatabase(
    directory,
    "UPDATE runs SET status = 'queued' WHERE run_id = 'run-1'",
  );
  assert.deepEqual(await convertAuthority(directory), {
    kind: "refused",
    reason: "projection-mismatch",
    detail: "runs",
  });
  assert.deepEqual(queryDatabase(directory, "PRAGMA user_version"), [
    { user_version: 1 },
  ]);
  assert.deepEqual(
    queryDatabase(
      directory,
      "SELECT count(*) AS count FROM sqlite_schema WHERE name LIKE 'solid%' OR name IN ('deliveries', 'authority_identity')",
    ),
    [{ count: 0 }],
  );
});

for (const barrier of [
  "baseline-validated",
  "schema-adopted",
  "schema-upgraded",
  "library-installed",
  "adoption-commit",
  "adoption-stranded",
])
  await test(`CLV-042 conversion interrupted at ${barrier} resumes to the same converted authority without a send`, async () => {
    const { directory, records: expected } = await baseline();
    await withChild(
      {
        script: "authority-conversion-child.ts",
        parameters: [directory, barrier],
      },
      async (child) => {
        assert.deepEqual(await child.exited, { code: null, signal: "SIGKILL" });
      },
    );
    const opening = await openAuthority(directory);
    assert.equal(opening.kind, "refused");
    assert.equal(Reflect.get(opening, "reason"), "conversion-required");
    assert.deepEqual(
      await convertAuthority(directory, { timing: fastTiming }),
      converted,
    );
    await assertConverted(directory, expected);
  });

after(removeTemporaryDirectories);
