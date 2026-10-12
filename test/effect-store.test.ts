import assert from "node:assert/strict";
import { after, test } from "node:test";
import { openAuthority } from "../src/broker/actor/authority.ts";
import { openedAuthority } from "./authority-actor-fixture.ts";
import {
  alterDatabase,
  queryDatabase,
  removeTemporaryDirectories,
  temporaryDirectory,
} from "./authority-store-fixture.ts";
import { digestOf } from "./digest-fixture.ts";
import {
  effectReport,
  effectRequest,
  later,
  noon,
  runningRun,
  sender,
  startOperation,
  tableRows,
  type Request,
} from "./effect-fixture.ts";

after(removeTemporaryDirectories);

type Fields = Readonly<Record<string, unknown>>;

const stopReport = {
  kind: "report-observation",
  commandId: "c-stop",
  runId: "run-1",
  condition: "stopped",
  reason: "worker-exit",
  operationId: startOperation,
};

async function leased(directory: string): Promise<Request> {
  const authority = await openedAuthority(directory);
  const send = sender(authority, { now: noon });
  await runningRun(send, { effectLimit: 2 });
  const request = effectRequest({
    commandId: "c-request-1",
    round: 1,
    resource: "repository",
  });
  for (const [command, documents] of [
    [request.command, request.documents],
    [stopReport, []],
  ] as const) {
    const receipt = await send(command, documents);
    assert.equal(receipt.kind, "accepted", JSON.stringify(receipt));
  }
  await authority.close();
  return request;
}

function storedOperation(request: Request): Fields {
  return {
    operation_id: request.operationId,
    run_id: "run-1",
    capability: "fake-harness",
    method: "run-turn",
    target: "workspace/main",
    payload: digestOf("build the package"),
    input_digest: request.inputDigest,
    units: 1,
    lease_key: "repository",
    recovery_limit: 3,
    status: "dispatch-pending",
    reason: null,
    attempts: 0,
    receipt: null,
    worker: null,
    result: null,
    requested_sequence: 3,
    wait_sequence: null,
    settled_sequence: null,
  };
}

await test("CLV-049 a budget, a request, its lease grant and a stop report are stored in their tables", async () => {
  const directory = await temporaryDirectory();
  const request = await leased(directory);
  assert.deepEqual(
    tableRows(directory, [
      "run_budgets",
      "operations",
      "leases",
      "effect_evidence",
      "stopped_operations",
    ]),
    [
      [
        {
          run_id: "run-1",
          effect_limit: 2,
          spent: 1,
          capabilities: '["fake-harness"]',
          exhausted_sequence: null,
        },
      ],
      [storedOperation(request)],
      [
        {
          resource_key: "repository",
          operation_id: request.operationId,
          generation: 1,
          expires_at: later,
          state: "held",
          granted_sequence: 4,
        },
      ],
      [
        {
          sequence: 3,
          run_id: "run-1",
          operation_id: request.operationId,
          disposition: "admitted",
          reason: null,
        },
      ],
      [{ operation_id: startOperation, run_id: "run-1", sequence: 5 }],
    ],
  );
  assert.deepEqual(
    queryDatabase(
      directory,
      "SELECT kind, created_sequence, released_sequence FROM outbox WHERE kind = 'protected-effect'",
    ),
    [
      {
        kind: "protected-effect",
        created_sequence: 4,
        released_sequence: null,
      },
    ],
  );
});

await test("CLV-049 the next opening continues from the stored rows: an equal request is recorded as existing, also for a final operation, a second request waits, and a request above the budget cancels the wait", async () => {
  const directory = await temporaryDirectory();
  await leased(directory);
  const reopened = await openedAuthority(directory);
  const send = sender(reopened, { now: noon });
  for (const next of [
    effectRequest({
      commandId: "c-request-again",
      round: 1,
      resource: "repository",
      transport: "retry 2 of call-7",
    }),
    effectRequest({
      commandId: "c-request-2",
      round: 2,
      resource: "repository",
    }),
    effectRequest({ commandId: "c-request-3", round: 3 }),
    effectRequest({ commandId: "c-request-3-again", round: 3 }),
  ]) {
    const receipt = await send(next.command, next.documents);
    assert.equal(receipt.kind, "accepted", JSON.stringify(receipt));
  }
  await reopened.close();
  assert.deepEqual(
    queryDatabase(
      directory,
      "SELECT sequence, disposition, reason FROM effect_evidence ORDER BY sequence",
    ),
    [
      { sequence: 3, disposition: "admitted", reason: null },
      { sequence: 6, disposition: "existing", reason: null },
      { sequence: 7, disposition: "admitted", reason: null },
      { sequence: 8, disposition: "refused", reason: "budget-exhausted" },
      { sequence: 9, disposition: "existing", reason: null },
    ],
  );
  assert.deepEqual(
    queryDatabase(
      directory,
      "SELECT status, reason, settled_sequence FROM operations ORDER BY requested_sequence",
    ),
    [
      { status: "dispatch-pending", reason: null, settled_sequence: null },
      { status: "cancelled", reason: "budget-exhausted", settled_sequence: 8 },
      { status: "refused", reason: "budget-exhausted", settled_sequence: null },
    ],
  );
  assert.deepEqual(
    queryDatabase(
      directory,
      "SELECT spent, exhausted_sequence FROM run_budgets",
    ),
    [{ spent: 2, exhausted_sequence: 8 }],
  );
  await (await openedAuthority(directory)).close();
});

await test("CLV-049 a request whose payload has no stored body is rejected and commits nothing", async () => {
  const directory = await temporaryDirectory();
  const authority = await openedAuthority(directory);
  const send = sender(authority, { now: noon });
  await runningRun(send, { effectLimit: 2 });
  const request = effectRequest({ commandId: "c-request-1", round: 1 });
  assert.deepEqual(await send(request.command), {
    kind: "rejected",
    reason: "missing-document",
    detail: digestOf("build the package"),
  });
  const report = effectReport(request, {
    commandId: "c-report-1",
    leaseGeneration: 1,
    worker: "worker-1",
    result: "the package is built",
  });
  assert.deepEqual(await send(report.command), {
    kind: "rejected",
    reason: "missing-document",
    detail: digestOf("the package is built"),
  });
  assert.equal((await authority.events()).length, 2);
  await authority.close();
});

await test("CLV-049 a turn reads the lease of a resource that a different run holds and the count of holding operations of all runs", async () => {
  const directory = await temporaryDirectory();
  await leased(directory);
  const authority = await openedAuthority(directory, {
    effects: { capacity: 1 },
  });
  const send = sender(authority, { now: noon });
  await runningRun(send, { effectLimit: 2, runId: "run-2" });
  const shared = effectRequest({
    commandId: "c-request-shared",
    round: 1,
    runId: "run-2",
    resource: "repository",
  });
  const free = effectRequest({
    commandId: "c-request-free",
    round: 2,
    runId: "run-2",
  });
  for (const next of [shared, free])
    assert.equal((await send(next.command, next.documents)).kind, "accepted");
  await authority.close();
  assert.deepEqual(
    queryDatabase(
      directory,
      "SELECT status, reason FROM operations WHERE run_id = 'run-2' ORDER BY requested_sequence",
    ),
    [
      { status: "waiting", reason: "resource" },
      { status: "waiting", reason: "ready" },
    ],
  );
});

const other = `sha256:${"9".repeat(64)}`;

function changedDigest(request: Request): string {
  const replaced = (column: string): string =>
    `${column} = replace(${column}, '${request.inputDigest}', '${other}')`;
  return [
    `UPDATE events SET ${replaced("payload")}, ${replaced("request")} WHERE type = 'effect.requested'`,
    `UPDATE commands SET ${replaced("request")}`,
    `UPDATE operations SET input_digest = '${other}'`,
  ].join("; ");
}

for (const [part, change] of [
  ["budgets", "UPDATE run_budgets SET spent = 0"],
  ["budgets", "DELETE FROM run_budgets"],
  ["operations", "UPDATE operations SET status = 'running'"],
  ["operations", "UPDATE operations SET attempts = 1"],
  ["leases", "UPDATE leases SET generation = 2"],
  ["leases", "UPDATE leases SET state = 'released'"],
  ["effect-evidence", "UPDATE effect_evidence SET disposition = 'refused'"],
  ["effect-evidence", "DELETE FROM effect_evidence"],
  ["stopped-operations", "DELETE FROM stopped_operations"],
  ["stopped-operations", "UPDATE stopped_operations SET sequence = 4"],
  ["documents", "DELETE FROM documents"],
  ["input-digests", changedDigest],
] as const)
  await test(`CLV-049 a state directory with a changed effect record is refused at the opening: ${part}, ${typeof change === "string" ? change : "a different input digest in the event and in the row"}`, async () => {
    const directory = await temporaryDirectory();
    const request = await leased(directory);
    alterDatabase(
      directory,
      typeof change === "string" ? change : change(request),
    );
    assert.deepEqual(await openAuthority(directory), {
      kind: "refused",
      reason: "projection-mismatch",
      detail: part,
    });
  });
