import assert from "node:assert/strict";
import { after, test } from "node:test";
import { openedAuthority } from "./authority-actor-fixture.ts";
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from "./authority-store-fixture.ts";
import { noon } from "./effect-fixture.ts";
import { start, request, work, move } from "./queue-work-fixture.ts";

after(removeTemporaryDirectories);

await test("CLV-377 a delayed enter reply cannot authorize computational work after its stage was released", async () => {
  const authority = await openedAuthority(await temporaryDirectory(), {
    clock: () => noon,
    leaseLimits: () => ({ capacity: 2, queueLimit: 1, queueWorkingLimit: 1 }),
  });
  try {
    await start(authority, { runId: "merge" });
    await request(authority, { runId: "merge", capability: "github" });
    assert.equal(
      (
        await work(authority, {
          runId: "merge",
          action: "enter",
          id: "old-stage",
        })
      ).kind,
      "accepted",
    );
    assert.equal(
      (
        await work(authority, {
          runId: "merge",
          action: "leave",
          id: "old-stage-leave",
        })
      ).kind,
      "accepted",
    );
    assert.deepEqual(
      await work(authority, {
        runId: "merge",
        action: "enter",
        id: "old-stage",
      }),
      { kind: "rejected", reason: "work-stage-released" },
    );
  } finally {
    await authority.close();
  }
});

await test("CLV-377 work-stage ownership rejects unknown operations, changed input and retired generations without reserving capacity", async () => {
  const authority = await openedAuthority(await temporaryDirectory(), {
    clock: () => noon,
    leaseLimits: () => ({ capacity: 4, queueLimit: 3, queueWorkingLimit: 1 }),
  });
  try {
    await start(authority, { runId: "merge" });
    const operation = await request(authority, {
      runId: "merge",
      capability: "github",
    });
    const base = {
      kind: "enter-operation-work",
      runId: "merge",
      operationId: operation.operationId,
      inputDigest: operation.inputDigest,
      leaseGeneration: 1,
    };
    const variants = [
      [
        { operationId: operation.operationId.replace('"merge"', '"absent"') },
        "unknown-operation",
      ],
      [{ inputDigest: `sha256:${"f".repeat(64)}` }, "input-mismatch"],
      [{ leaseGeneration: 2 }, "retired-lease-generation"],
    ] as const;
    for (const [extra, reason] of variants)
      assert.deepEqual(
        await authority.execute(
          {
            ...base,
            ...extra,
            commandId: `refuse-${reason}`,
            stageId: `refuse-${reason}`,
          },
          { recordedAt: noon, epoch: authority.epoch, documents: [] },
        ),
        { kind: "rejected", reason },
      );
    const entered = await work(authority, {
      runId: "merge",
      action: "enter",
      id: "valid-enter",
    });
    assert.equal(entered.kind, "accepted");
    assert.deepEqual(
      await work(authority, {
        runId: "merge",
        action: "enter",
        id: "second-enter",
      }),
      { kind: "rejected", reason: "work-already-entered" },
    );
  } finally {
    await authority.close();
  }
});

await test("CLV-377 an unrelated manual merge keeps its reserved capacity while queued work is at the global cap", async () => {
  const authority = await openedAuthority(await temporaryDirectory(), {
    clock: () => noon,
    leaseLimits: () => ({ capacity: 4, queueLimit: 3, queueWorkingLimit: 1 }),
  });
  try {
    await start(authority, { runId: "agent" });
    await request(authority, { runId: "agent" });
    await start(authority, { runId: "manual", kind: "manual" });
    await request(authority, { runId: "manual", capability: "github" });
    assert.equal(
      (
        await work(authority, {
          runId: "manual",
          action: "enter",
          id: "manual-enter",
        })
      ).kind,
      "accepted",
    );
    assert.equal(
      (
        await work(authority, {
          runId: "manual",
          action: "leave",
          id: "manual-leave",
        })
      ).kind,
      "accepted",
    );
  } finally {
    await authority.close();
  }
});

await test("CLV-377 pausing an owned merge holds its next computational stage until resume", async () => {
  const authority = await openedAuthority(await temporaryDirectory(), {
    clock: () => noon,
    leaseLimits: () => ({ capacity: 2, queueLimit: 1, queueWorkingLimit: 1 }),
  });
  try {
    await start(authority, { runId: "merge" });
    await request(authority, { runId: "merge", capability: "github" });
    assert.equal(
      (await move(authority, { runId: "merge", action: "pause" })).kind,
      "accepted",
    );
    assert.deepEqual(
      await work(authority, {
        runId: "merge",
        action: "enter",
        id: "paused-enter",
      }),
      {
        kind: "rejected",
        reason: "run-work-held",
      },
    );
    assert.equal(
      (await move(authority, { runId: "merge", action: "resume" })).kind,
      "accepted",
    );
    assert.equal(
      (
        await work(authority, {
          runId: "merge",
          action: "enter",
          id: "paused-enter",
        })
      ).kind,
      "accepted",
    );
  } finally {
    await authority.close();
  }
});

await test("CLV-377 unset global work limits preserve retained legacy reserve behavior", async () => {
  const authority = await openedAuthority(await temporaryDirectory(), {
    clock: () => noon,
    leaseLimits: () => ({ capacity: 4, queueLimit: 1 }),
  });
  try {
    for (const id of ["old-one", "old-two"]) {
      await start(authority, { runId: id, kind: "legacy" });
      assert.equal(
        (await request(authority, { runId: id })).status,
        "dispatch-pending",
      );
    }
  } finally {
    await authority.close();
  }
});

await test("CLV-377 GitHub local verification reserves active work atomically and releases it for remote CI without another lease or budget unit", async () => {
  const authority = await openedAuthority(await temporaryDirectory(), {
    clock: () => noon,
    leaseLimits: () => ({ capacity: 4, queueLimit: 3, queueWorkingLimit: 1 }),
  });
  try {
    await start(authority, { runId: "merge" });
    await request(authority, { runId: "merge", capability: "github" });
    const entered = await work(authority, {
      runId: "merge",
      action: "enter",
      id: "enter-merge",
    });
    assert.equal(entered.kind, "accepted", JSON.stringify(entered));
    assert.equal(
      (
        await work(authority, {
          runId: "merge",
          action: "enter",
          id: "enter-merge",
        })
      ).kind,
      "duplicate",
    );
    await start(authority, { runId: "agent" });
    assert.equal(
      (await request(authority, { runId: "agent" })).status,
      "waiting",
    );
    assert.equal(
      (
        await work(authority, {
          runId: "merge",
          action: "leave",
          id: "leave-merge",
        })
      ).kind,
      "accepted",
    );
    assert.equal(
      (await authority.effects.operations("agent"))[0]?.status,
      "dispatch-pending",
    );
    assert.equal((await authority.effects.budget("merge"))?.spent, 1);
    assert.equal((await authority.effects.operations("merge")).length, 1);
    const refused = await work(authority, {
      runId: "merge",
      action: "enter",
      id: "enter-again",
    });
    assert.deepEqual(refused, {
      kind: "rejected",
      reason: "queue-working-capacity-exceeded",
    });
  } finally {
    await authority.close();
  }
});

await test("CLV-377 a one-lane last-unit merge can verify, retains its reservation through reopening and rejects stale owners", async () => {
  const directory = await temporaryDirectory();
  const options = {
    clock: () => noon,
    leaseLimits: () => ({ capacity: 2, queueLimit: 1, queueWorkingLimit: 1 }),
  };
  let authority = await openedAuthority(directory, options);
  try {
    await start(authority, { runId: "merge" });
    await request(authority, { runId: "merge", capability: "github" });
    assert.equal(
      (
        await work(authority, {
          runId: "merge",
          action: "enter",
          id: "one-enter",
        })
      ).kind,
      "accepted",
    );
    await authority.close();
    authority = await openedAuthority(directory, options);
    assert.equal(
      (
        await work(authority, {
          runId: "merge",
          action: "leave",
          id: "stale-leave",
          generation: 2,
        })
      ).kind,
      "rejected",
    );
    assert.equal(
      (
        await work(authority, {
          runId: "merge",
          action: "leave",
          id: "one-leave",
        })
      ).kind,
      "accepted",
    );
    assert.equal((await authority.effects.budget("merge"))?.spent, 1);
  } finally {
    await authority.close();
  }
});

await test("CLV-377 retained legacy queue agents share the active-work cap after reopening, while manual and scheduled populations stay separate", async () => {
  const directory = await temporaryDirectory();
  const options = {
    clock: () => noon,
    leaseLimits: () => ({ capacity: 6, queueLimit: 4, queueWorkingLimit: 1 }),
  };
  let authority = await openedAuthority(directory, options);
  try {
    await start(authority, { runId: "legacy", kind: "legacy" });
    assert.equal(
      (await request(authority, { runId: "legacy" })).status,
      "dispatch-pending",
    );
    await authority.close();
    authority = await openedAuthority(directory, options);
    await start(authority, { runId: "modern" });
    assert.equal(
      (await request(authority, { runId: "modern" })).status,
      "waiting",
    );
    for (const kind of ["manual", "other"]) {
      await start(authority, { runId: kind, kind: kind });
      assert.equal(
        (await request(authority, { runId: kind })).status,
        "dispatch-pending",
      );
    }
  } finally {
    await authority.close();
  }
});

await test("CLV-377 a legacy queued agent cannot race past already admitted modern active work", async () => {
  const authority = await openedAuthority(await temporaryDirectory(), {
    clock: () => noon,
    leaseLimits: () => ({ capacity: 4, queueLimit: 3, queueWorkingLimit: 1 }),
  });
  try {
    await start(authority, { runId: "modern" });
    await request(authority, { runId: "modern" });
    await start(authority, { runId: "legacy", kind: "legacy" });
    assert.equal(
      (await request(authority, { runId: "legacy" })).status,
      "waiting",
    );
  } finally {
    await authority.close();
  }
});
