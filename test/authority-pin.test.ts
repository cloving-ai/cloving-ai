import assert from "node:assert/strict";
import { after, test } from "node:test";
import { openAuthority } from "../src/broker/actor/authority.ts";
import { workflowPin } from "../src/broker/workflow-pin.ts";
import { continuation, recorded } from "./authority-fixture.ts";
import {
  alterDatabase,
  executeStored,
  manifest,
  opened,
  pin,
  queryDatabase,
  storedGate,
  removeTemporaryDirectories,
  temporaryDirectory,
} from "./authority-store-fixture.ts";

const admission = storedGate[0];
const started = storedGate[1];

await test("CLV-007 an admitted run commits its pinned manifest and resumes only through that pin", async () => {
  const directory = await temporaryDirectory();
  const first = (await opened(directory)).store;
  assert.equal(
    (await first.execute(admission, { ...recorded, manifest })).kind,
    "accepted",
  );
  await first.close();
  assert.deepEqual(queryDatabase(directory, "SELECT pin FROM definitions"), [
    { pin },
  ]);
  assert.deepEqual(queryDatabase(directory, "SELECT workflow FROM runs"), [
    { workflow: pin },
  ]);

  const { store } = await opened(directory);
  const regenerated = {
    ...manifest,
    artifacts: { "steps.mjs": "b".repeat(64), "flow.mjs": "a".repeat(64) },
  };
  assert.deepEqual(await store.resumePinned("run-1", regenerated), {
    kind: "admitted",
    manifest,
  });
  assert.deepEqual(
    await store.resumePinned("run-1", {
      ...manifest,
      artifacts: { ...manifest.artifacts, "steps.mjs": "d".repeat(64) },
    }),
    {
      kind: "rejected",
      reason: "pinned-manifest-mismatch",
      detail: "artifacts",
    },
  );
  assert.deepEqual(await store.resumePinned("run-9", manifest), {
    kind: "rejected",
    reason: "unknown-run",
    detail: "run-9",
  });
  await store.close();
});

await test("CLV-007 admission without its matching manifest is rejected without a run", async () => {
  const directory = await temporaryDirectory();
  const { store } = await opened(directory);
  for (const [command, context, reason] of [
    [admission, recorded, "missing-manifest"],
    [
      { ...admission, workflow: `sha256:${"0".repeat(64)}` },
      { ...recorded, manifest },
      "workflow-pin-mismatch",
    ],
    [started, { ...recorded, manifest }, "unexpected-manifest"],
  ] as const)
    assert.deepEqual(await store.execute(command, context), {
      kind: "rejected",
      reason,
    });
  assert.equal((await store.state()).sequence, 0);
  await store.close();
  assert.deepEqual(
    queryDatabase(directory, "SELECT count(*) AS count FROM definitions"),
    [{ count: 0 }],
  );
});

await test("CLV-007 a stored manifest that no longer matches its pin is refused", async () => {
  for (const stored of [
    JSON.stringify({ ...manifest, capabilities: ["fake-harness", "tracker"] }),
    "{",
  ]) {
    const directory = await temporaryDirectory();
    const first = (await opened(directory)).store;
    await first.execute(admission, { ...recorded, manifest });
    await first.close();
    alterDatabase(directory, `UPDATE definitions SET manifest = '${stored}'`);
    assert.deepEqual(await openAuthority(directory), {
      kind: "refused",
      reason: "projection-mismatch",
      detail: "definitions",
    });
  }
});

const changed = {
  ...manifest,
  artifacts: { ...manifest.artifacts, "steps.mjs": "d".repeat(64) },
};
const regenerated = {
  ...manifest,
  artifacts: { "steps.mjs": "b".repeat(64), "flow.mjs": "a".repeat(64) },
};

await test("CLV-007 a waiting run continues or resumes only with a manifest that matches its stored pin", async () => {
  const directory = await temporaryDirectory();
  const { store } = await opened(directory);
  for (const command of storedGate.slice(0, 3))
    assert.equal((await executeStored(store, command)).kind, "accepted");
  const decision = storedGate[3];
  const mismatch = {
    kind: "rejected",
    reason: "pinned-manifest-mismatch",
    detail: "artifacts",
  };
  assert.deepEqual(await store.execute(decision, recorded), {
    kind: "rejected",
    reason: "missing-manifest",
  });
  assert.deepEqual(
    await store.execute(decision, { ...recorded, manifest: changed }),
    mismatch,
  );
  assert.equal((await store.state()).sequence, 3);
  assert.equal(
    (await store.execute(decision, { ...recorded, manifest: regenerated }))
      .kind,
    "accepted",
  );
  assert.deepEqual(await store.execute(decision, recorded), {
    kind: "duplicate",
    sequence: 4,
    intents: [continuation],
  });
  const pause = {
    kind: "pause-run",
    commandId: "c-5",
    runId: "run-1",
    expectedRevision: 4,
  };
  assert.equal((await store.execute(pause, recorded)).kind, "accepted");
  const resume = {
    kind: "resume-run",
    commandId: "c-6",
    runId: "run-1",
    expectedRevision: 5,
  };
  assert.deepEqual(await store.execute(resume, recorded), {
    kind: "rejected",
    reason: "missing-manifest",
  });
  assert.deepEqual(
    await store.execute(resume, { ...recorded, manifest: changed }),
    mismatch,
  );
  assert.equal((await store.state()).runs["run-1"]?.status, "paused");
  assert.equal(
    (await store.execute(resume, { ...recorded, manifest: regenerated })).kind,
    "accepted",
  );
  await store.close();
});

await test("CLV-007 a terminal run cannot resume through its pin", async () => {
  const directory = await temporaryDirectory();
  const { store } = await opened(directory);
  assert.equal(
    (await store.execute(admission, { ...recorded, manifest })).kind,
    "accepted",
  );
  assert.equal(
    (
      await store.execute(
        {
          kind: "cancel-run",
          commandId: "c-2",
          runId: "run-1",
          expectedRevision: 1,
        },
        recorded,
      )
    ).kind,
    "accepted",
  );
  assert.deepEqual(await store.resumePinned("run-1", manifest), {
    kind: "rejected",
    reason: "terminal-run",
    detail: "run-1",
  });
  await store.close();
});

await test("CLV-007 a second admission with the same pin keeps the first stored manifest in memory and after reopening", async () => {
  const directory = await temporaryDirectory();
  const ordered = { ...manifest, capabilities: ["fake-harness", "tracker"] };
  const reversed = { ...manifest, capabilities: ["tracker", "fake-harness"] };
  const first = (await opened(directory)).store;
  const workflow = workflowPin(ordered);
  for (const [runId, variant] of [
    ["run-1", ordered],
    ["run-2", reversed],
  ] as const)
    assert.equal(
      (
        await first.execute(
          { ...admission, commandId: `admit-${runId}`, runId, workflow },
          { ...recorded, manifest: variant },
        )
      ).kind,
      "accepted",
    );
  const before = await first.resumePinned("run-2", reversed);
  await first.close();
  const { store } = await opened(directory);
  const after = await store.resumePinned("run-2", reversed);
  await store.close();
  assert.deepEqual(before, { kind: "admitted", manifest: ordered });
  assert.deepEqual(after, before);
});

after(removeTemporaryDirectories);
