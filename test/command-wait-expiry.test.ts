import assert from "node:assert/strict";
import { after, test } from "node:test";
import { rebuild } from "../src/authority/reducer.ts";
import { commandWaitKey } from "../src/authority/command-waits.ts";
import {
  opened,
  removeTemporaryDirectories,
} from "./authority-store-fixture.ts";
import {
  context,
  opening,
  permission,
  pinned,
  waitStore,
} from "./command-wait-fixture.ts";

const key = commandWaitKey("run-1", "team-review");
const start = Date.parse(context.recordedAt);
const deadline = start + permission.maximumWaitSeconds * 1000;
const expire = {
  kind: "expire-command-wait",
  commandId: "expire-review",
  runId: "run-1",
  waitName: "team-review",
};
const at = (time: number) => ({
  ...context,
  recordedAt: new Date(time).toISOString(),
});

after(removeTemporaryDirectories);

const expired = {
  state: "timed-out",
  settledAt: deadline,
  nextCheckAt: null,
  reason: "command-wait-timeout",
};
const expiryCases = [
  {
    offset: -1,
    reply: { kind: "rejected", reason: "command-wait-not-expired" },
    changed: {},
    joinOffset: -1,
  },
  {
    offset: 0,
    reply: { kind: "accepted", sequence: 4, intents: [] },
    changed: expired,
    joinOffset: 1000,
  },
  {
    offset: 1,
    reply: { kind: "accepted", sequence: 4, intents: [] },
    changed: expired,
    joinOffset: 1000,
  },
];
for (const scenario of expiryCases)
  await test(`CLV-235 explicit expiry at deadline ${String(scenario.offset)}ms uses the immutable allowance`, async () => {
    const { store, directory } = await waitStore();
    try {
      assert.equal((await store.execute(opening, context)).kind, "accepted");
      const original = (await store.state()).commandWaits?.[key];
      assert.deepEqual(
        await store.execute(expire, at(deadline + scenario.offset)),
        scenario.reply,
      );
      assert.deepEqual((await store.state()).commandWaits?.[key], {
        ...original,
        ...scenario.changed,
      });
      assert.equal(
        (
          await store.execute(
            { ...opening, commandId: "later-step" },
            at(deadline + scenario.joinOffset),
          )
        ).kind,
        "accepted",
      );
      const before = (await store.state()).commandWaits;
      assert.deepEqual(rebuild(await store.events()).commandWaits, before);
      await store.close();
      const reopened = (await opened(directory)).store;
      try {
        assert.deepEqual((await reopened.state()).commandWaits, before);
      } finally {
        await reopened.close();
      }
    } finally {
      await store.close();
    }
  });

await test("CLV-235 a call after downtime records expiry against the original deadline", async () => {
  const { store, directory } = await waitStore();
  try {
    assert.equal((await store.execute(opening, context)).kind, "accepted");
  } finally {
    await store.close();
  }
  const reopened = (await opened(directory)).store;
  try {
    assert.equal(
      (
        await reopened.execute(
          { ...opening, commandId: "recovery" },
          at(deadline + 86_400_000),
        )
      ).kind,
      "accepted",
    );
    const wait = (await reopened.state()).commandWaits?.[key];
    assert.ok(wait);
    assert.equal(wait.state, "timed-out");
    assert.equal(wait.deadline, deadline);
    assert.equal(wait.settledAt, deadline);
    assert.equal(wait.nextCheckAt, null);
    assert.equal((await reopened.effects.budget("run-1"))?.spent, 0);
  } finally {
    await reopened.close();
  }
});

await test("CLV-235 pause and resume preserve the original deadline and expiry remains recordable while paused", async () => {
  const { store } = await waitStore();
  try {
    assert.equal((await store.execute(opening, context)).kind, "accepted");
    assert.equal(
      (
        await store.execute(
          {
            kind: "pause-run",
            commandId: "pause",
            runId: "run-1",
            expectedRevision: 2,
          },
          at(start + 86_400_000),
        )
      ).kind,
      "accepted",
    );
    assert.equal(
      (
        await store.execute(
          { ...opening, commandId: "joined-while-paused" },
          at(start + 2 * 86_400_000),
        )
      ).kind,
      "accepted",
    );
    assert.equal((await store.state()).commandWaits?.[key]?.deadline, deadline);
    assert.equal((await store.execute(expire, at(deadline))).kind, "accepted");
    assert.equal(
      (
        await store.execute(
          {
            kind: "resume-run",
            commandId: "resume",
            runId: "run-1",
            expectedRevision: 3,
          },
          { ...at(deadline + 1), manifest: pinned },
        )
      ).kind,
      "accepted",
    );
    assert.equal((await store.state()).commandWaits?.[key]?.state, "timed-out");
    assert.equal((await store.state()).commandWaits?.[key]?.deadline, deadline);
  } finally {
    await store.close();
  }
});

for (const kind of ["complete-run", "fail-run", "cancel-run"])
  await test(`CLV-235 ${kind} closes a named allowance without renewing it on a repeated opening`, async () => {
    const { store } = await waitStore();
    try {
      assert.equal((await store.execute(opening, context)).kind, "accepted");
      const original = (await store.state()).commandWaits?.[key];
      const endedAt = start + 120_000;
      assert.equal(
        (
          await store.execute(
            {
              kind,
              commandId: "end",
              runId: "run-1",
              expectedRevision: 2,
            },
            at(endedAt),
          )
        ).kind,
        "accepted",
      );
      assert.equal(
        (
          await store.execute(
            { ...opening, commandId: "joined-after-end" },
            at(endedAt + 1000),
          )
        ).kind,
        "accepted",
      );
      assert.deepEqual((await store.state()).commandWaits?.[key], {
        ...original,
        state: "cancelled",
        reason: "command-wait-run-ended",
        settledAt: endedAt,
        nextCheckAt: null,
      });
      assert.deepEqual(
        rebuild(await store.events()).commandWaits,
        (await store.state()).commandWaits,
      );
    } finally {
      await store.close();
    }
  });
