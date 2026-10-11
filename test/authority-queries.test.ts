import assert from "node:assert/strict";
import { after, test } from "node:test";
import { openedAuthority } from "./authority-actor-fixture.ts";
import {
  answeredQuestion,
  executeAll,
  noon,
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
