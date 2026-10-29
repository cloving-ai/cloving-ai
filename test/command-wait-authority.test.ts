import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  commandWaitKey,
  type CommandWaitsState,
} from "../src/authority/command-waits.ts";
import { rebuild } from "../src/authority/reducer.ts";
import { effectInputDigest } from "../src/broker/effect-restore.ts";
import {
  opened,
  removeTemporaryDirectories,
} from "./authority-store-fixture.ts";
import {
  context,
  opening,
  pinned,
  waitStore,
  startWaitRun,
} from "./command-wait-fixture.ts";
import { request } from "./effect-pure-fixture.ts";

after(removeTemporaryDirectories);

await test("CLV-235 opening leaves a fully spent ordinary budget exhausted", async () => {
  const { store } = await waitStore();
  try {
    const fields = {
      capability: "command",
      method: "run:review-state",
      target: "review-state",
      payload: opening.payload,
    };
    for (const round of [1, 2]) {
      const receipt = await store.execute(
        {
          ...request(round),
          ...fields,
          inputDigest: effectInputDigest(fields),
        },
        { ...context, epoch: store.epoch },
      );
      assert.equal(receipt.kind, "accepted");
      assert.equal("disposition" in receipt && receipt.disposition, "admitted");
    }
    assert.equal((await store.effects.budget("run-1"))?.spent, 2);
    assert.equal((await store.execute(opening, context)).kind, "accepted");
    assert.equal((await store.effects.budget("run-1"))?.spent, 2);
    const refused = await store.execute(
      { ...request(3), ...fields, inputDigest: effectInputDigest(fields) },
      { ...context, epoch: store.epoch },
    );
    assert.equal(refused.kind, "accepted");
    assert.equal("disposition" in refused && refused.disposition, "refused");
    assert.equal((await store.effects.budget("run-1"))?.spent, 2);
  } finally {
    await store.close();
  }
});

await test("CLV-235 legacy pins have no command wait authority", async () => {
  const { commandWaits, ...legacy } = pinned;
  assert.ok(commandWaits["team-review"]);
  const { store } = await waitStore(legacy);
  try {
    assert.deepEqual(await store.execute(opening, context), {
      kind: "rejected",
      reason: "command-wait-not-declared",
    });
    assert.equal((await store.state()).commandWaits, undefined);
  } finally {
    await store.close();
  }
});

await test("CLV-235 the same wait name in separate runs has isolated durable allowances", async () => {
  const { store, directory } = await waitStore();
  let expected: CommandWaitsState | undefined;
  try {
    assert.equal((await store.execute(opening, context)).kind, "accepted");
    await startWaitRun(store, { runId: "run-2" });
    const later = new Date(Date.parse(context.recordedAt) + 500).toISOString();
    assert.equal(
      (
        await store.execute(
          { ...opening, commandId: "open-second", runId: "run-2" },
          { ...context, recordedAt: later },
        )
      ).kind,
      "accepted",
    );
    assert.equal(
      (
        await store.execute(
          {
            kind: "cancel-run",
            commandId: "drop-first",
            runId: "run-1",
            expectedRevision: 2,
          },
          context,
        )
      ).kind,
      "accepted",
    );
    expected = (await store.state()).commandWaits;
    assert.equal(Object.keys(expected ?? {}).length, 2);
    assert.equal(
      expected?.[commandWaitKey("run-1", "team-review")]?.state,
      "cancelled",
    );
    assert.equal(
      expected[commandWaitKey("run-2", "team-review")]?.state,
      "waiting",
    );
    assert.equal(
      expected[commandWaitKey("run-2", "team-review")]?.startedAt,
      Date.parse(later),
    );
    assert.deepEqual(rebuild(await store.events()).commandWaits, expected);
  } finally {
    await store.close();
  }
  const reopened = (await opened(directory)).store;
  try {
    assert.deepEqual((await reopened.state()).commandWaits, expected);
  } finally {
    await reopened.close();
  }
});

for (const command of [
  opening,
  {
    kind: "expire-command-wait",
    commandId: "expire",
    runId: "run-1",
    waitName: "team-review",
  },
])
  await test(`CLV-235 ${command.kind} refuses an invalid authority clock`, async () => {
    const { store } = await waitStore();
    try {
      assert.equal((await store.execute(opening, context)).kind, "accepted");
      assert.deepEqual(
        await store.execute(
          { ...command, commandId: "invalid-clock" },
          {
            ...context,
            recordedAt: "invalid-time",
          },
        ),
        {
          kind: "rejected",
          reason: "invalid-recorded-time",
        },
      );
    } finally {
      await store.close();
    }
  });
