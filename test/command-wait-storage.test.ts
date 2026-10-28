import assert from "node:assert/strict";
import { after, test } from "node:test";
import { documentDigest } from "../src/broker/decision-restore.ts";
import {
  commandWaitRows,
  commandWaitState,
} from "../src/broker/command-wait-restore.ts";
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

after(removeTemporaryDirectories);

const startedAt = Date.parse(context.recordedAt);
const storedWait = {
  runId: "run-1",
  name: "team-review",
  inputDigest: opening.payload,
  ...permission,
  startedAt,
  deadline: startedAt + permission.maximumWaitSeconds * 1000,
  nextCheckAt: startedAt,
  state: "waiting" as const,
  settledAt: null,
  reason: null,
};

await test("CLV-235 wait rows sort by run then name and round trip without changing allowance identity", () => {
  const identities = [
    ["run-2", "zeta-review"],
    ["run-1", "zeta-review"],
    ["run-2", "alpha-review"],
    ["run-1", "alpha-review"],
  ] as const;
  const waits = Object.fromEntries(
    identities.map(([runId, name]) => [
      commandWaitKey(runId, name),
      { ...storedWait, runId, name },
    ]),
  );
  const rows = commandWaitRows(waits);
  assert.deepEqual(
    rows.map(({ runId, name }) => [runId, name]),
    [
      ["run-1", "alpha-review"],
      ["run-1", "zeta-review"],
      ["run-2", "alpha-review"],
      ["run-2", "zeta-review"],
    ],
  );
  assert.deepEqual(commandWaitState(rows), { commandWaits: waits });
  assert.deepEqual(
    Object.values(waits).map(({ runId, name }) => [runId, name]),
    identities,
  );
});

await test("CLV-235 restoration rejects an unknown stored wait state and preserves an absent legacy allowance", () => {
  assert.deepEqual(commandWaitState([]), {});
  assert.throws(() => commandWaitState([{ ...storedWait, state: "ready" }]), {
    message: "invalid-command-wait-state",
  });
});

await test("CLV-235 authority opens a pinned wait without spending an effect or dispatching a check", async () => {
  const { store } = await waitStore();
  try {
    assert.deepEqual(await store.execute(opening, context), {
      kind: "accepted",
      sequence: 3,
      intents: [],
    });
    assert.equal((await store.effects.budget("run-1"))?.spent, 0);
  } finally {
    await store.close();
  }
});

await test("CLV-235 identical concurrent openings retain one input and deadline across reopen", async () => {
  const { store, directory } = await waitStore();
  try {
    const replies = await Promise.all(
      ["first", "second"].map((commandId) =>
        store.execute({ ...opening, commandId }, context),
      ),
    );
    assert.ok(replies.every((reply) => reply.kind === "accepted"));
    const startedAt = Date.parse(context.recordedAt);
    const expected = {
      runId: "run-1",
      name: "team-review",
      command: permission.command,
      inputDigest: opening.payload,
      maximumWaitSeconds: permission.maximumWaitSeconds,
      pollEverySeconds: permission.pollEverySeconds,
      startedAt,
      deadline: startedAt + 2_592_000_000,
      nextCheckAt: startedAt,
      state: "waiting",
      settledAt: null,
      reason: null,
    };
    assert.deepEqual((await store.state()).commandWaits, {
      [JSON.stringify(["run-1", "team-review"])]: expected,
    });
    await store.close();
    const reopened = (await opened(directory)).store;
    try {
      assert.equal(
        (
          await reopened.execute(
            { ...opening, commandId: "new-step" },
            {
              ...context,
              recordedAt: new Date(startedAt + 86_400_000).toISOString(),
            },
          )
        ).kind,
        "accepted",
      );
      assert.deepEqual((await reopened.state()).commandWaits, {
        [JSON.stringify(["run-1", "team-review"])]: expected,
      });
    } finally {
      await reopened.close();
    }
  } finally {
    await store.close();
  }
});

await test("CLV-235 changed input cannot reopen a named allowance", async () => {
  const { store } = await waitStore();
  try {
    assert.equal((await store.execute(opening, context)).kind, "accepted");
    const before = await store.state();
    const changed = JSON.stringify({ change: 43 });
    assert.deepEqual(
      await store.execute(
        {
          ...opening,
          commandId: "changed-input",
          payload: documentDigest(changed),
        },
        { ...context, documents: [changed] },
      ),
      {
        kind: "rejected",
        reason: "command-wait-input-mismatch",
      },
    );
    assert.deepEqual(await store.state(), before);
  } finally {
    await store.close();
  }
});

for (const extra of [
  { waitName: "unknown" },
  { target: "other-command" },
  { maximumWaitSeconds: 86_400 },
  { pollEverySeconds: 60 },
])
  await test(`CLV-235 wait opening checks pinned permission ${JSON.stringify(extra)}`, async () => {
    const { store } = await waitStore();
    try {
      assert.deepEqual(await store.execute({ ...opening, ...extra }, context), {
        kind: "rejected",
        reason: "command-wait-not-declared",
      });
      assert.equal((await store.effects.budget("run-1"))?.spent, 0);
      assert.equal((await store.events()).length, 2);
    } finally {
      await store.close();
    }
  });

for (const extra of [
  { waitName: "bad_name" },
  { maximumWaitSeconds: 2_592_001 },
  { pollEverySeconds: 59 },
  { deadline: "2100-01-01T00:00:00.000Z" },
  { exempt: true },
  { units: 0 },
  { executable: "/bin/other" },
])
  await test(`CLV-235 wait opening rejects malformed or override fields ${JSON.stringify(extra)}`, async () => {
    const { store } = await waitStore();
    try {
      assert.deepEqual(await store.execute({ ...opening, ...extra }, context), {
        kind: "rejected",
        reason: "invalid-command",
      });
      assert.equal((await store.events()).length, 2);
    } finally {
      await store.close();
    }
  });

for (const kind of ["pause-run", "complete-run", "fail-run", "cancel-run"])
  await test(`CLV-235 ${kind} prevents a first wait opening`, async () => {
    const { store } = await waitStore();
    try {
      assert.equal(
        (
          await store.execute(
            {
              kind,
              commandId: "change-run",
              runId: "run-1",
              expectedRevision: 2,
            },
            context,
          )
        ).kind,
        "accepted",
      );
      assert.deepEqual(await store.execute(opening, context), {
        kind: "rejected",
        reason: "command-wait-run-not-running",
      });
    } finally {
      await store.close();
    }
  });

await test("CLV-235 wait opening refuses declaration overlays", async () => {
  const { store } = await waitStore();
  try {
    assert.deepEqual(
      await store.execute(opening, {
        ...context,
        manifest: {
          ...pinned,
          commandWaits: { ...pinned.commandWaits, extra: permission },
        },
      }),
      { kind: "rejected", reason: "unexpected-manifest" },
    );
  } finally {
    await store.close();
  }
});
