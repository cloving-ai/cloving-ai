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

async function seedCommandRun(directory: string): Promise<void> {
  const pinned = {
    ...manifest,
    capabilities: ["command"],
    commands: ["scan"],
  };
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

function commandRequest(name: string) {
  const fields = {
    capability: "command",
    method: `run:${name}`,
    target: name,
    payload: documentDigest("{}"),
  };
  return { ...request(1), ...fields, inputDigest: effectInputDigest(fields) };
}

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
