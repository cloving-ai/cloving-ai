import assert from "node:assert/strict";
import { after, test } from "node:test";
import { openedAuthority } from "./authority-actor-fixture.ts";
import {
  admission,
  answeredQuestion,
  executeAll,
  noon,
  started,
} from "./authority-decision-fixture.ts";
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from "./authority-store-fixture.ts";

after(removeTemporaryDirectories);

await test("CLV-008 a receipt read returns the committed record of one command, also after a reopening", async () => {
  const directory = await temporaryDirectory();
  const first = await openedAuthority(directory);
  await executeAll(first, answeredQuestion);
  const receipt = await first.queries.receipt("c-5");
  assert.deepEqual(
    {
      commandId: receipt?.commandId,
      sequence: receipt?.sequence,
      runId: receipt?.runId,
      recordedAt: receipt?.recordedAt,
      kind: receipt?.command.kind,
      decision: receipt?.command.decision,
    },
    {
      commandId: "c-5",
      sequence: 5,
      runId: "run-1",
      recordedAt: noon,
      kind: "decide-gate",
      decision: "answered",
    },
  );
  assert.match(receipt?.commandDigest ?? "", /^sha256:[0-9a-f]{64}$/);
  assert.equal(await first.queries.receipt("c-9"), undefined);
  await first.close();
  const second = await openedAuthority(directory);
  assert.deepEqual(await second.queries.receipt("c-5"), receipt);
  await second.close();
});

await test("CLV-008 an event read resumes after a sequence, keeps its limit and reports the first and the latest sequence", async () => {
  const authority = await openedAuthority(await temporaryDirectory());
  await executeAll(authority, answeredQuestion);
  const page = await authority.queries.eventsAfter({ after: 2, limit: 2 });
  assert.deepEqual(
    page.events.map((event) => [event.sequence, event.type]),
    [
      [3, "gate.opened"],
      [4, "gate.wait-registered"],
    ],
  );
  assert.deepEqual([page.earliest, page.latest], [1, 5]);
  const rest = await authority.queries.eventsAfter({ after: 4, limit: 100 });
  assert.deepEqual(
    rest.events.map((event) => event.sequence),
    [5],
  );
  const beyond = await authority.queries.eventsAfter({ after: 9, limit: 10 });
  assert.deepEqual([beyond.events, beyond.latest], [[], 5]);
  const other = await authority.queries.eventsAfter({
    after: 0,
    limit: 10,
    runId: "run-9",
  });
  assert.deepEqual(other.events, []);
  const own = await authority.queries.eventsAfter({
    after: 0,
    limit: 10,
    runId: "run-1",
  });
  assert.equal(own.events.length, 5);
  await authority.close();
});

await test("CLV-008 a sequence read gives the latest sequence of the ledger and of each run", async () => {
  const authority = await openedAuthority(await temporaryDirectory());
  assert.deepEqual(await authority.queries.sequences(), {
    latest: 0,
    runs: {},
    times: {},
  });
  await executeAll(authority, answeredQuestion);
  assert.deepEqual(await authority.queries.sequences(), {
    latest: 5,
    runs: { "run-1": 5 },
    times: { "run-1": noon },
  });
  await authority.close();
});

const completionOutcome = {
  outcome: "blocked",
  outcomeReason: "Review needs repair",
};

async function completedAuthority(directory: string) {
  const authority = await openedAuthority(directory);
  const completion = {
    kind: "complete-run",
    commandId: "completed",
    runId: "run-1",
    expectedRevision: 2,
  };
  const commands = [
    admission,
    started,
    { ...completion, ...completionOutcome },
    { ...admission, commandId: "other-admitted", runId: "run-2" },
    { ...started, commandId: "other-started", runId: "run-2" },
    { ...completion, commandId: "other-completed", runId: "run-2" },
  ];
  for (const command of commands)
    assert.equal(
      (await executeAll(authority, [{ command }]))[0]?.kind,
      "accepted",
    );
  return authority;
}

await test("CLV-072 completion reads are scoped to the run and snapshot sequence", async () => {
  const authority = await completedAuthority(await temporaryDirectory());
  try {
    for (const cursor of [
      { runId: "run-1", atOrBefore: 2 },
      { runId: "run-2", atOrBefore: 5 },
      { runId: "missing", atOrBefore: 6 },
    ])
      assert.equal(await authority.queries.latestCompletion(cursor), undefined);
    const event = await authority.queries.latestCompletion({
      runId: "run-1",
      atOrBefore: 6,
    });
    assert.deepEqual(event, {
      sequence: 3,
      type: "run.completed",
      runId: "run-1",
      commandId: "completed",
      recordedAt: noon,
      payload: completionOutcome,
    });
    assert.deepEqual(
      await authority.queries.latestCompletion({
        runId: "run-1",
        atOrBefore: 3,
      }),
      event,
    );
    const legacy = await authority.queries.latestCompletion({
      runId: "run-2",
      atOrBefore: 6,
    });
    assert.equal(legacy?.sequence, 6);
    assert.deepEqual(legacy.payload, {});
  } finally {
    await authority.close();
  }
});

await test("CLV-072 completion reads survive reopening", async () => {
  const directory = await temporaryDirectory();
  const authority = await completedAuthority(directory);
  await authority.close();
  const reopened = await openedAuthority(directory);
  try {
    const event = await reopened.queries.latestCompletion({
      runId: "run-1",
      atOrBefore: 6,
    });
    assert.equal(event?.sequence, 3);
    assert.deepEqual(event.payload, completionOutcome);
  } finally {
    await reopened.close();
  }
});
