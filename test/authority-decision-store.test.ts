import assert from "node:assert/strict";
import { after, test } from "node:test";
import { openAuthority } from "../src/broker/actor/authority.ts";
import {
  deliverUntil,
  executePinned,
  externalService,
  openedAuthority,
  quickCleanupTiming,
} from "./authority-actor-fixture.ts";
import {
  admission,
  answer,
  answerText,
  answeredQuestion,
  deadline,
  downgrade,
  executeAll,
  executeTyped,
  promptText,
  question,
  started,
  wait,
} from "./authority-decision-fixture.ts";
import {
  alterDatabase,
  queryDatabase,
  removeTemporaryDirectories,
  storedGate,
  temporaryDirectory,
  withChild,
} from "./authority-store-fixture.ts";
import { digestOf } from "./digest-fixture.ts";

after(removeTemporaryDirectories);

const versionTwoTables = [
  "events",
  "definitions",
  "runs",
  "commands",
  "outbox",
  "deliveries",
  "authority_identity",
];

function rows(directory: string, tables: readonly string[]): unknown {
  return tables.map((table) =>
    queryDatabase(directory, `SELECT * FROM ${table} ORDER BY rowid`),
  );
}

function version(directory: string): unknown {
  return queryDatabase(directory, "PRAGMA user_version");
}

async function answered(directory: string): Promise<void> {
  const authority = await openedAuthority(directory);
  const receipts = await executeAll(authority, answeredQuestion);
  assert.deepEqual(
    receipts.map((receipt) => receipt.kind),
    ["accepted", "accepted", "accepted", "accepted", "accepted"],
  );
  await authority.close();
}

await test("CLV-008 the full question and the full answer text survive process termination and a projection rebuild", async () => {
  const directory = await temporaryDirectory();
  await withChild(
    { script: "authority-commands-child.ts", parameters: [directory] },
    async (child) => {
      await child.waitFor("committed");
      await child.kill();
    },
  );
  const authority = await openedAuthority(directory, {
    timing: quickCleanupTiming,
  });
  const state = await authority.state();
  assert.deepEqual(state.gates["run-1 design-1"], {
    runId: "run-1",
    gateId: "design-1",
    kind: "question",
    label: 1,
    subject: digestOf(promptText),
    prompt: digestOf(promptText),
    expiresAt: null,
    generation: 1,
    revision: 2,
    wait: "registered",
    outcome: {
      decision: "answered",
      answer: digestOf(answerText),
      sequence: 5,
    },
    openedSequence: 3,
  });
  assert.equal(state.questions, 1);
  assert.equal(state.details["run-1"]?.generation, 2);
  assert.equal(
    await authority.queries.document(digestOf(promptText)),
    promptText,
  );
  assert.equal(
    await authority.queries.document(digestOf(answerText)),
    answerText,
  );
  assert.equal(
    await authority.queries.document(digestOf("unknown")),
    undefined,
  );
  const events = JSON.stringify(await authority.events());
  assert.equal(events.includes("table parser"), false);
  assert.equal(events.includes("Which parser"), false);
  await authority.close();
});

await test("CLV-008 a version 2 state directory opens as the current version with its version 2 rows unchanged", async () => {
  const directory = await temporaryDirectory();
  const first = await openedAuthority(directory);
  for (const command of storedGate) await executePinned(first, command);
  await first.close();
  alterDatabase(directory, downgrade);
  assert.deepEqual(version(directory), [{ user_version: 2 }]);
  const before = rows(directory, versionTwoTables);
  const migrated = await openedAuthority(directory);
  const state = await migrated.state();
  await migrated.close();
  assert.deepEqual(version(directory), [{ user_version: 7 }]);
  assert.deepEqual(rows(directory, versionTwoTables), before);
  assert.equal(state.gates["run-1 gate-1"]?.kind, "untyped");
  assert.deepEqual(state.gates["run-1 gate-1"].outcome, {
    decision: "approved",
    answer: null,
    sequence: 4,
  });
  assert.equal(state.details["run-1"]?.generation, 2);
  assert.deepEqual(
    queryDatabase(
      directory,
      "SELECT version FROM schema_migrations ORDER BY version",
    ),
    [1, 2, 3, 4, 5, 6, 7].map((version) => ({ version })),
  );
});

await test("CLV-008 a version 2 state directory with the decision text cancelled on its gate opens as the current version with its continuation", async () => {
  const directory = await temporaryDirectory();
  const first = await openedAuthority(directory);
  for (const command of storedGate)
    await executePinned(
      first,
      command["kind"] === "decide-gate"
        ? { ...command, decision: "cancelled" }
        : command,
    );
  const eligible = await first.eligibleIntents();
  await first.close();
  assert.deepEqual(
    eligible.map((intent) => intent.kind),
    ["continue-run"],
  );
  alterDatabase(directory, downgrade);
  const before = rows(directory, versionTwoTables);
  const migrated = await openedAuthority(directory);
  const state = await migrated.state();
  assert.deepEqual(await migrated.eligibleIntents(), eligible);
  await migrated.close();
  assert.deepEqual(version(directory), [{ user_version: 7 }]);
  assert.deepEqual(rows(directory, versionTwoTables), before);
  assert.deepEqual(state.gates["run-1 gate-1"]?.outcome, {
    decision: "cancelled",
    answer: null,
    sequence: 4,
  });
});

await test("CLV-008 an interrupted migration leaves version 2, and the next opening completes it", async () => {
  const directory = await temporaryDirectory();
  const first = await openedAuthority(directory);
  for (const command of storedGate) await executePinned(first, command);
  await first.close();
  alterDatabase(directory, downgrade);
  alterDatabase(
    directory,
    "CREATE TRIGGER fail_migration BEFORE INSERT ON schema_migrations BEGIN SELECT RAISE(ABORT, 'injected-migration-failure'); END;",
  );
  const before = rows(directory, versionTwoTables);
  const refused = await openAuthority(directory);
  assert.equal(refused.kind, "refused");
  assert.equal(refused.reason, "storage-failure");
  assert.match(refused.detail, /injected-migration-failure/);
  assert.deepEqual(version(directory), [{ user_version: 2 }]);
  assert.deepEqual(rows(directory, versionTwoTables), before);
  assert.deepEqual(
    queryDatabase(
      directory,
      "SELECT name FROM sqlite_schema WHERE name IN ('gates', 'run_details', 'documents')",
    ),
    [],
  );
  alterDatabase(directory, "DROP TRIGGER fail_migration;");
  const completed = await openedAuthority(directory);
  await completed.close();
  assert.deepEqual(version(directory), [{ user_version: 7 }]);
  assert.deepEqual(rows(directory, versionTwoTables), before);
});

for (const [part, sql] of [
  ["gates", "UPDATE gates SET decision = 'approved'"],
  ["gates", "UPDATE gates SET wait = 'pending'"],
  ["gates", "UPDATE gates SET continuation = NULL"],
  ["details", "UPDATE run_details SET generation = 9"],
  ["documents", "UPDATE documents SET body = 'changed'"],
  ["documents", "DELETE FROM documents"],
] as const)
  await test(`CLV-008 a state directory with a changed decision record is refused at the opening: ${sql}`, async () => {
    const directory = await temporaryDirectory();
    await answered(directory);
    alterDatabase(directory, sql);
    assert.deepEqual(await openAuthority(directory), {
      kind: "refused",
      reason: "projection-mismatch",
      detail: part,
    });
  });

await test("CLV-008 a command that names a text digest without a stored body is rejected and commits nothing", async () => {
  const authority = await openedAuthority(await temporaryDirectory());
  await executeAll(authority, [{ command: admission }, { command: started }]);
  assert.deepEqual(await executeTyped(authority, { command: question }), {
    kind: "rejected",
    reason: "missing-document",
    detail: digestOf(promptText),
  });
  assert.deepEqual(
    await executeTyped(authority, {
      command: question,
      documents: ["a different text"],
    }),
    {
      kind: "rejected",
      reason: "missing-document",
      detail: digestOf(promptText),
    },
  );
  assert.equal((await authority.state()).sequence, 2);
  await authority.close();
});

await test("CLV-008 the continuation of an answered question carries the gate, the decision and the answer digest", async () => {
  const service = externalService();
  const authority = await openedAuthority(
    await temporaryDirectory(),
    service.options,
  );
  await executeTyped(authority, { command: admission });
  await deliverUntil(authority, () =>
    Promise.resolve(service.sent.length === 1),
  );
  await executeAll(authority, answeredQuestion.slice(1));
  await deliverUntil(authority, () =>
    Promise.resolve(service.sent.length === 2),
  );
  assert.deepEqual(
    service.sent.map((intent) => [
      intent.kind,
      intent.runId,
      intent.gateId,
      intent.decision,
      intent.answer,
    ]),
    [
      ["start-run", "run-1", undefined, undefined, undefined],
      ["continue-run", "run-1", "design-1", "answered", digestOf(answerText)],
    ],
  );
  await authority.close();
});

await test("CLV-008 an answer before the wait registration is delivered one time after the registration, also across a restart", async () => {
  const directory = await temporaryDirectory();
  const service = externalService();
  const first = await openedAuthority(directory, service.options);
  await executeTyped(first, { command: admission });
  await deliverUntil(first, () => Promise.resolve(service.sent.length === 1));
  await executeAll(first, [
    { command: started },
    { command: question, documents: [promptText] },
    { command: { ...answer, commandId: "c-4" }, documents: [answerText] },
  ]);
  assert.deepEqual(await first.eligibleIntents(), []);
  await first.close();
  const second = await openedAuthority(directory, service.options);
  assert.equal(
    (await executeTyped(second, { command: { ...wait, commandId: "c-5" } }))
      .kind,
    "accepted",
  );
  await deliverUntil(second, () => Promise.resolve(service.sent.length === 2));
  await second.close();
  const third = await openedAuthority(directory, service.options);
  await deliverUntil(third, async () =>
    (await third.operations()).every((operation) =>
      operation.deliveries.every((delivery) => delivery.outcome !== null),
    ),
  );
  assert.deepEqual(
    service.sent.map((intent) => intent.kind),
    ["start-run", "continue-run"],
  );
  await third.close();
});

await test("CLV-008 a waiting question has no open delivery and no eligible intent, before and after a restart", async () => {
  const directory = await temporaryDirectory();
  const service = externalService();
  const first = await openedAuthority(directory, service.options);
  await executeTyped(first, { command: admission });
  await deliverUntil(first, () => Promise.resolve(service.sent.length === 1));
  await executeAll(first, [
    { command: started },
    { command: question, documents: [promptText] },
    { command: wait },
  ]);
  const idle = async (authority: typeof first): Promise<unknown> => [
    await authority.eligibleIntents(),
    (await authority.operations()).flatMap((operation) =>
      operation.deliveries.filter((delivery) => delivery.outcome === null),
    ),
    (await authority.state()).runs["run-1"]?.status,
  ];
  assert.deepEqual(await idle(first), [[], [], "waiting_gate"]);
  await first.close();
  const second = await openedAuthority(directory, service.options);
  assert.deepEqual(await idle(second), [[], [], "waiting_gate"]);
  assert.equal(service.sent.length, 1);
  await second.close();
});

const expiry = {
  kind: "expire-gate",
  commandId: "c-5",
  runId: "run-1",
  gateId: "design-1",
};
const quotaWait = {
  kind: "report-observation",
  commandId: "c-7",
  runId: "run-1",
  condition: "quota-wait",
  reason: "provider-quota",
  retryAt: deadline,
  operationId: "segment-1",
};
const timedApproval = {
  command: { ...question, gateKind: "approval", expiresAt: deadline },
  documents: [promptText],
};

await test("CLV-008 an expired gate and a reported observation commit through the authority and survive a reopening", async () => {
  const directory = await temporaryDirectory();
  const first = await openedAuthority(directory);
  const receipts = await executeAll(first, [
    { command: admission },
    { command: started },
    timedApproval,
    { command: wait },
    { command: expiry },
    { command: { ...expiry, commandId: "c-6" }, recordedAt: deadline },
    { command: quotaWait },
  ]);
  assert.deepEqual(
    receipts.map((receipt) =>
      receipt.kind === "rejected" ? receipt.reason : receipt.kind,
    ),
    [
      "accepted",
      "accepted",
      "accepted",
      "accepted",
      "not-expired",
      "accepted",
      "accepted",
    ],
  );
  const state = await first.state();
  await first.close();
  const second = await openedAuthority(directory);
  assert.deepEqual(await second.state(), state);
  assert.equal(state.gates["run-1 design-1"]?.outcome?.decision, "expired");
  assert.deepEqual(
    [
      state.details["run-1"]?.observation?.condition,
      state.details["run-1"]?.observation?.operationId,
    ],
    ["quota-wait", "segment-1"],
  );
  await second.close();
});
