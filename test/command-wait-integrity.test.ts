import assert from "node:assert/strict";
import { after, test } from "node:test";
import { openAuthority } from "../src/broker/actor/authority.ts";
import { commandWaitKey } from "../src/authority/command-waits.ts";
import {
  alterDatabase,
  removeTemporaryDirectories,
} from "./authority-store-fixture.ts";
import {
  context,
  opening,
  permission,
  waitStore,
} from "./command-wait-fixture.ts";

after(removeTemporaryDirectories);

async function closedStore(): Promise<string> {
  const { store, directory } = await waitStore();
  try {
    assert.equal((await store.execute(opening, context)).kind, "accepted");
  } finally {
    await store.close();
  }
  return directory;
}

await test("CLV-235 reopening refuses a wait whose input document disappeared", async () => {
  const directory = await closedStore();
  alterDatabase(directory, "PRAGMA foreign_keys = OFF; DELETE FROM documents;");
  const result = await openAuthority(directory);
  if (result.kind === "opened") await result.authority.close();
  assert.deepEqual(result, {
    kind: "refused",
    reason: "projection-mismatch",
    detail: "documents",
  });
});

await test("CLV-235 reopening rechecks the recorded allowance against its pinned permission", async () => {
  const directory = await closedStore();
  alterDatabase(
    directory,
    `
    UPDATE events SET payload = json_set(payload, '$.maximumWaitSeconds', '1296000'),
      request = json_set(request, '$.maximumWaitSeconds', 1296000)
      WHERE type = 'command-wait.opened';
    UPDATE commands SET request = json_set(request, '$.maximumWaitSeconds', 1296000)
      WHERE command_id = 'open-review';
  `,
  );
  const result = await openAuthority(directory);
  if (result.kind === "opened") await result.authority.close();
  assert.deepEqual(result, {
    kind: "refused",
    reason: "projection-mismatch",
    detail: "command-waits",
  });
});

await test("CLV-235 ending a run after expiry records timeout at the original deadline", async () => {
  const { store } = await waitStore();
  try {
    assert.equal((await store.execute(opening, context)).kind, "accepted");
    const deadline =
      Date.parse(context.recordedAt) + permission.maximumWaitSeconds * 1000;
    assert.equal(
      (
        await store.execute(
          {
            kind: "cancel-run",
            commandId: "late-drop",
            runId: "run-1",
            expectedRevision: 2,
          },
          { ...context, recordedAt: new Date(deadline + 1).toISOString() },
        )
      ).kind,
      "accepted",
    );
    const wait = (await store.state()).commandWaits?.[
      commandWaitKey("run-1", "team-review")
    ];
    assert.ok(wait);
    assert.equal(wait.state, "timed-out");
    assert.equal(wait.reason, "command-wait-timeout");
    assert.equal(wait.settledAt, deadline);
  } finally {
    await store.close();
  }
});

for (const recordedAt of [
  "invalid-time",
  new Date(Date.parse(context.recordedAt) - 1).toISOString(),
])
  await test(`CLV-235 run-end settlement refuses invalid or backward time ${recordedAt}`, async () => {
    const { store } = await waitStore();
    try {
      assert.equal((await store.execute(opening, context)).kind, "accepted");
      const before = await store.state();
      assert.deepEqual(
        await store.execute(
          {
            kind: "cancel-run",
            commandId: "bad-clock-drop",
            runId: "run-1",
            expectedRevision: 2,
          },
          { ...context, recordedAt },
        ),
        { kind: "rejected", reason: "invalid-command-wait-time" },
      );
      assert.deepEqual(await store.state(), before);
    } finally {
      await store.close();
    }
  });
