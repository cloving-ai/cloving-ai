import assert from "node:assert/strict";
import { test } from "node:test";
import { admitted } from "../src/broker/authority-admission.ts";
import { effectInputDigest } from "../src/broker/effect-restore.ts";
import {
  declaredManifest,
  pinnedIdentity,
  readExecutionManifest,
  resumePinned,
} from "../src/execution-pin.ts";
import { admit, lastState, recorded, run } from "./authority-fixture.ts";
import { manifest, opened } from "./authority-store-fixture.ts";
import { request } from "./effect-pure-fixture.ts";
import { workflowPin } from "../src/broker/workflow-pin.ts";
import { documentDigest } from "../src/broker/decision-restore.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { workflowRegistry } from "../src/service/registry.ts";
import type { ExecutionManifest } from "../src/workflow-admission.ts";

const wait = {
  command: "scan",
  maximumWaitSeconds: 2_592_000,
  pollEverySeconds: 3_600,
};
const waitManifest = {
  ...manifest,
  capabilities: ["command"],
  commands: ["scan", "refresh"],
  commandWaits: { "team-review": wait },
};

await test("CLV-235 queued wait manifests retain both permissions and pin queue changes", () => {
  const queued = { ...waitManifest, queue: true };
  assert.deepEqual(readExecutionManifest(queued), queued);
  assert.deepEqual(declaredManifest(waitManifest, queued), queued);
  assert.notEqual(workflowPin(queued), workflowPin(waitManifest));
  assert.deepEqual(resumePinned(queued, waitManifest), {
    kind: "rejected",
    reason: "pinned-manifest-mismatch",
    detail: "queue",
  });
});

await test("CLV-235 command wait permissions survive manifest storage and declaration overlay", () => {
  assert.deepEqual(
    readExecutionManifest(JSON.parse(JSON.stringify(waitManifest))),
    waitManifest,
  );
  const { commandWaits, ...legacy } = waitManifest;
  assert.deepEqual(declaredManifest(legacy, { commandWaits }), waitManifest);
  assert.equal(
    pinnedIdentity(readExecutionManifest(legacy)),
    pinnedIdentity(legacy),
  );
  assert.equal(
    pinnedIdentity({ ...legacy, commandWaits: {} }),
    pinnedIdentity(legacy),
  );
  assert.equal(
    Object.hasOwn(readExecutionManifest(legacy), "commandWaits"),
    false,
  );
  assert.equal(
    workflowPin(legacy),
    "sha256:a99cc08d8f6aa7becff5961ddec220200f2f694c212159f5bdea46c4094a3993",
  );
});

await test("CLV-235 every wait permission changes the pin and refuses incompatible resumption", () => {
  for (const commandWaits of [
    {},
    { "another-name": wait },
    { "team-review": { ...wait, command: "refresh" } },
    { "team-review": { ...wait, maximumWaitSeconds: 86_400 } },
    { "team-review": { ...wait, pollEverySeconds: 60 } },
  ]) {
    const changed = { ...waitManifest, commandWaits };
    assert.notEqual(workflowPin(waitManifest), workflowPin(changed));
    assert.deepEqual(resumePinned(waitManifest, changed), {
      kind: "rejected",
      reason: "pinned-manifest-mismatch",
      detail: "commandWaits",
    });
    assert.equal(resumePinned(changed, waitManifest).kind, "rejected");
  }
});

await test("CLV-235 wait pins canonicalize map and entry key order", () => {
  const first = { ...waitManifest, commandWaits: { a: wait, Z: wait } };
  const reordered = {
    ...waitManifest,
    commandWaits: {
      Z: {
        pollEverySeconds: 3_600,
        maximumWaitSeconds: 2_592_000,
        command: "scan",
      },
      a: wait,
    },
  };
  assert.equal(workflowPin(first), workflowPin(reordered));
  assert.notEqual(workflowPin(first), workflowPin(waitManifest));
});

await test("CLV-235 malformed stored wait permissions fail closed", () => {
  for (const commandWaits of [
    null,
    undefined,
    [],
    "team-review",
    { "team-review": null },
    { "team-review": { ...wait, command: "secret" } },
    { "team-review": { ...wait, maximumWaitSeconds: 2_592_001 } },
    { "team-review": { ...wait, pollEverySeconds: 59 } },
    { "team-review": { ...wait, exempt: true } },
  ])
    assert.throws(
      () => readExecutionManifest({ ...waitManifest, commandWaits }),
      /invalid-command-waits/,
    );
  assert.throws(
    () => readExecutionManifest({ ...waitManifest, capabilities: ["claude"] }),
    /invalid-command-waits/,
  );
});

await test("CLV-235 the registry cannot add wait permission to a legacy pin", async () => {
  const { commandWaits, ...legacy } = waitManifest;
  const registry = workflowRegistry([
    {
      workflowId: "review",
      manifest: legacy,
      availability: "available",
      submission: { maximumBytes: 64, fields: {} },
      resolver: {
        id: "fixture",
        version: "1",
        resolve: () => Promise.resolve({ kind: "resolved", input: {} }),
      },
      commandWaits,
    },
  ]);
  assert.deepEqual(registry.byId("review")?.manifest, waitManifest);
  assert.equal(await registry.available(legacy), undefined);
  assert.deepEqual(await registry.available(waitManifest), waitManifest);
});

await test("CLV-178 command names survive storage and change the execution pin", () => {
  const pinned = { ...manifest, commands: ["scan", "refresh"] };
  assert.deepEqual(
    readExecutionManifest(JSON.parse(JSON.stringify(pinned))),
    pinned,
  );
  assert.deepEqual(declaredManifest(manifest, pinned), pinned);
  assert.notEqual(pinnedIdentity(pinned), pinnedIdentity(manifest));
  assert.notEqual(
    pinnedIdentity({ ...manifest, commands: ["scan"] }),
    pinnedIdentity({ ...manifest, handoffs: ["scan"] }),
  );
  assert.equal(
    pinnedIdentity(pinned),
    pinnedIdentity({ ...pinned, commands: ["refresh", "scan"] }),
  );
  assert.equal(
    pinnedIdentity({ ...manifest, commands: [] }),
    pinnedIdentity(manifest),
  );
  assert.deepEqual(resumePinned(pinned, manifest), {
    kind: "rejected",
    reason: "pinned-manifest-mismatch",
    detail: "commands",
  });
});

async function seedCommandRun(
  directory: string,
  pinned: ExecutionManifest = {
    ...manifest,
    capabilities: ["command"],
    commands: ["scan"],
  },
): Promise<void> {
  const first = (await opened(directory)).store;
  try {
    assert.equal(
      (
        await first.execute(
          {
            ...admit,
            workflow: workflowPin(pinned),
            effectLimit: 2,
            capabilities: '["command"]',
          },
          { ...recorded, manifest: pinned },
        )
      ).kind,
      "accepted",
    );
    assert.equal(
      (
        await first.execute(
          {
            kind: "mark-started",
            commandId: "start",
            runId: "run-1",
            expectedRevision: 1,
          },
          recorded,
        )
      ).kind,
      "accepted",
    );
  } finally {
    await first.close();
  }
}

await test("CLV-235 reopening keeps wait permissions and refuses new permissions on existing runs", async () => {
  const { commandWaits, ...legacy } = waitManifest;
  for (const pinned of [legacy, waitManifest])
    await withFiles({}, async (directory) => {
      await seedCommandRun(directory, pinned);
      const reopened = (await opened(directory)).store;
      try {
        assert.deepEqual(await reopened.queries.manifest("run-1"), pinned);
        assert.equal((await reopened.effects.budget("run-1"))?.spent, 0);
        const context = { ...recorded, epoch: reopened.epoch };
        const pause = {
          kind: "pause-run",
          commandId: "pause",
          runId: "run-1",
          expectedRevision: 2,
        };
        assert.equal((await reopened.execute(pause, context)).kind, "accepted");
        const resume = {
          kind: "resume-run",
          commandId: "resume",
          runId: "run-1",
          expectedRevision: 3,
        };
        const changed = {
          ...pinned,
          commandWaits: {
            "team-review": {
              ...commandWaits["team-review"],
              pollEverySeconds: 60,
            },
          },
        };
        assert.deepEqual(
          await reopened.execute(resume, { ...context, manifest: changed }),
          {
            kind: "rejected",
            reason: "pinned-manifest-mismatch",
            detail: "commandWaits",
          },
        );
        assert.equal((await reopened.state()).runs["run-1"]?.status, "paused");
        assert.deepEqual(await reopened.queries.manifest("run-1"), pinned);
        assert.equal(
          (await reopened.execute(resume, { ...context, manifest: pinned }))
            .kind,
          "accepted",
        );
      } finally {
        await reopened.close();
      }
    });
});

function commandRequest(name: string, round = 1) {
  const fields = {
    capability: "command",
    method: `run:${name}`,
    target: name,
    payload: documentDigest("{}"),
  };
  return {
    ...request(round),
    ...fields,
    inputDigest: effectInputDigest(fields),
  };
}

await test("CLV-235 ordinary commands named by a wait still spend the ordinary budget", () =>
  withFiles({}, async (directory) => {
    await seedCommandRun(directory, waitManifest);
    const reopened = (await opened(directory)).store;
    try {
      const context = { ...recorded, epoch: reopened.epoch, documents: ["{}"] };
      for (const round of [1, 2, 3]) {
        const result = await reopened.execute(
          commandRequest("scan", round),
          context,
        );
        assert.equal(result.kind, "accepted");
        assert.equal(
          "disposition" in result && result.disposition,
          round < 3 ? "admitted" : "refused",
        );
        assert.equal(
          (await reopened.effects.budget("run-1"))?.spent,
          Math.min(round, 2),
        );
      }
    } finally {
      await reopened.close();
    }
  }));

await test("CLV-178 reopened authority keeps the run's command permissions and spends nothing on a refusal", () =>
  withFiles({}, async (directory) => {
    await seedCommandRun(directory);
    const reopened = (await opened(directory)).store;
    try {
      assert.deepEqual((await reopened.queries.manifest("run-1"))?.commands, [
        "scan",
      ]);
      const context = { ...recorded, epoch: reopened.epoch, documents: ["{}"] };
      assert.deepEqual(
        await reopened.execute(commandRequest("secret"), context),
        {
          kind: "rejected",
          reason: "command-not-declared",
        },
      );
      assert.equal((await reopened.effects.budget("run-1"))?.spent, 0);
      const receipt = await reopened.execute(commandRequest("scan"), context);
      assert.equal(receipt.kind, "accepted", JSON.stringify(receipt));
      assert.equal((await reopened.effects.budget("run-1"))?.spent, 1);
    } finally {
      await reopened.close();
    }
  }));

await test("CLV-178 malformed stored command declarations fail closed", () => {
  for (const commands of [
    null,
    undefined,
    "scan",
    [1],
    [""],
    ["a_b"],
    ["scan", "scan"],
  ])
    assert.throws(
      () => readExecutionManifest({ ...manifest, commands }),
      /invalid-commands/,
    );
});

await test("CLV-178 command authority checks the requesting run's own pinned declaration", () => {
  const state = lastState(run([admit]));
  const fields = {
    capability: "command",
    method: "run:scan",
    target: "scan",
    payload: `sha256:${"a".repeat(64)}`,
  };
  const command = {
    ...request(1),
    ...fields,
    units: 1,
    inputDigest: effectInputDigest(fields),
  };
  const definitions = new Map([
    ["pin-1", { ...manifest, commands: ["scan"] }],
    ["other-pin", { ...manifest, commands: ["secret"] }],
  ]);
  assert.equal(
    admitted(state, { command, definitions, manifest: undefined }).kind,
    "admissible",
  );
  for (const extra of [
    { method: "run:secret" },
    { method: "scan" },
    { method: "run:constructor" },
    { runId: "other-run" },
  ]) {
    const proposed = { ...command, ...extra };
    assert.deepEqual(
      admitted(state, {
        definitions,
        manifest: undefined,
        command: { ...proposed, inputDigest: effectInputDigest(proposed) },
      }),
      {
        kind: "rejected",
        reason: "command-not-declared",
      },
    );
  }
});
