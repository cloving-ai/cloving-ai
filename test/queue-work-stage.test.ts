import assert from "node:assert/strict";
import { after, test } from "node:test";
import type {
  Authority,
  OperationView,
} from "../src/broker/actor/authority.ts";
import { operationDigest } from "../src/broker/operation-digest.ts";
import { openedAuthority } from "./authority-actor-fixture.ts";
import {
  temporaryDirectory,
  removeTemporaryDirectories,
} from "./authority-store-fixture.ts";
import { noon } from "./effect-fixture.ts";
import { start, request, work, move } from "./queue-work-fixture.ts";

after(removeTemporaryDirectories);

async function withStage(
  check: (scene: {
    readonly authority: Authority;
    readonly operation: OperationView;
    readonly limits: {
      capacity: number;
      queueLimit: number;
      queueWorkingLimit: number;
    };
  }) => Promise<void>,
) {
  const limits = { capacity: 4, queueLimit: 3, queueWorkingLimit: 1 };
  const authority = await openedAuthority(await temporaryDirectory(), {
    clock: () => noon,
    leaseLimits: () => limits,
  });
  try {
    await start(authority, { runId: "merge" });
    const operation = await request(authority, {
      runId: "merge",
      capability: "github",
    });
    assert.equal(
      (
        await work(authority, {
          runId: "merge",
          action: "enter",
          id: "first-stage",
        })
      ).kind,
      "accepted",
    );
    await check({ authority, operation, limits });
  } finally {
    await authority.close();
  }
}

await test("CLV-377 a delayed old leave cannot release a newer computational stage", () =>
  withStage(async ({ authority }) => {
    const left = await work(authority, {
      runId: "merge",
      action: "leave",
      id: "first-stage-leave",
    });
    assert.equal(left.kind, "accepted");
    const entered = await work(authority, {
      runId: "merge",
      action: "enter",
      id: "second-stage",
    });
    assert.equal(entered.kind, "accepted");
    assert.deepEqual(
      await work(authority, {
        runId: "merge",
        action: "enter",
        id: "first-stage",
      }),
      { kind: "rejected", reason: "stale-work-stage" },
    );
    await start(authority, { runId: "waiting" });
    assert.equal(
      (await request(authority, { runId: "waiting" })).status,
      "waiting",
    );
    assert.deepEqual(
      await work(authority, {
        runId: "merge",
        action: "leave",
        id: "late-first-leave",
        stageId: "first-stage",
      }),
      { kind: "rejected", reason: "stale-work-stage" },
    );
    assert.equal(
      (await authority.effects.operations("waiting"))[0]?.status,
      "waiting",
    );
    assert.equal(
      (
        await work(authority, {
          runId: "merge",
          action: "leave",
          id: "first-stage-leave",
          stageId: "first-stage",
        })
      ).kind,
      "duplicate",
    );
    assert.equal(
      (await authority.effects.operations("waiting"))[0]?.status,
      "waiting",
    );
  }));

await test("CLV-377 adopting retained work stays counted above a lower cap and respects pause", () =>
  withStage(async ({ authority, limits }) => {
    limits.queueWorkingLimit = 2;
    await start(authority, { runId: "agent" });
    assert.equal(
      (await request(authority, { runId: "agent" })).status,
      "dispatch-pending",
    );
    limits.queueWorkingLimit = 1;
    assert.equal(
      (
        await work(authority, {
          runId: "merge",
          action: "enter",
          id: "first-stage",
        })
      ).kind,
      "duplicate",
    );
    assert.equal(
      (await move(authority, { runId: "merge", action: "pause" })).kind,
      "accepted",
    );
    assert.deepEqual(
      await work(authority, {
        runId: "merge",
        action: "enter",
        id: "first-stage",
      }),
      { kind: "rejected", reason: "run-work-held" },
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
          id: "first-stage",
        })
      ).kind,
      "duplicate",
    );
  }));

await test("CLV-377 a retained enter receipt cannot bypass a retired lease or epoch", () =>
  withStage(async ({ authority, operation }) => {
    const event = (await authority.events()).find(
      (row) => row.type === "operation.work-entered",
    );
    assert.ok(event);
    const command: unknown = JSON.parse(event.request);
    assert.deepEqual(
      await authority.execute(command, {
        recordedAt: noon,
        epoch: authority.epoch + 1,
        documents: [],
      }),
      { kind: "rejected", reason: "stale-epoch" },
    );
    const granted = (await authority.events()).find(
      (row) => row.type === "lease.granted",
    );
    assert.ok(granted?.payload["expiresAt"]);
    const expired = await authority.execute(
      {
        kind: "expire-lease",
        commandId: `expire-lease:${operationDigest(operation.operationId)}:1`,
        runId: "merge",
        operationId: operation.operationId,
        leaseGeneration: 1,
      },
      {
        recordedAt: granted.payload["expiresAt"],
        epoch: authority.epoch,
        documents: [],
      },
    );
    assert.equal(expired.kind, "accepted");
    assert.deepEqual(
      await work(authority, {
        runId: "merge",
        action: "enter",
        id: "first-stage",
      }),
      { kind: "rejected", reason: "lease-expired" },
    );
  }));
