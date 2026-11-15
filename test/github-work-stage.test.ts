import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { after, test } from "node:test";
import { join } from "node:path";
import {
  recordedWorkStage,
  releasedWorkStage,
} from "../src/daemon/github-work-stage.ts";
import { writeRecord } from "../src/daemon/operation-journal.ts";
import {
  temporaryDirectory,
  removeTemporaryDirectories,
} from "./authority-store-fixture.ts";

import { openedAuthority } from "./authority-actor-fixture.ts";
import { start, request, stagePort } from "./queue-work-fixture.ts";
import { noon } from "./effect-fixture.ts";
import { capacityCalls } from "../src/daemon/github-work-capacity.ts";

after(removeTemporaryDirectories);

const intent = {
  runId: "run",
  operationId: "operation",
  inputDigest: `sha256:${"a".repeat(64)}`,
  leaseGeneration: 1,
};

await test("CLV-377 the private stage identity is stable before entry and stale local release acknowledgement cannot overwrite a newer stage", async () => {
  const folder = await temporaryDirectory();
  const first = await recordedWorkStage(intent, folder);
  assert.deepEqual(await recordedWorkStage(intent, folder), first);
  assert.equal(first.commandId, first.stageId);
  assert.equal(
    (await stat(join(folder, "work-stage.json"))).mode & 0o777,
    0o600,
  );
  await releasedWorkStage(first, folder);
  const next = await recordedWorkStage(intent, folder);
  assert.notEqual(next.stageId, first.stageId);
  const saved = await readFile(join(folder, "work-stage.json"), "utf8");
  await releasedWorkStage(first, folder);
  assert.equal(await readFile(join(folder, "work-stage.json"), "utf8"), saved);
});

await test("CLV-377 a current generation gets a fresh stage while a retired journal reader cannot replace its identity", async () => {
  const folder = await temporaryDirectory();
  const first = await recordedWorkStage(intent, folder);
  const current = await recordedWorkStage(
    { ...intent, leaseGeneration: 2 },
    folder,
  );
  assert.notEqual(current.stageId, first.stageId);
  assert.equal(current.leaseGeneration, 2);
  const saved = await readFile(join(folder, "work-stage.json"), "utf8");
  await assert.rejects(
    recordedWorkStage(intent, folder),
    /github-operation-stopped/,
  );
  assert.equal(await readFile(join(folder, "work-stage.json"), "utf8"), saved);
});

await test("CLV-377 malformed and differently bound stage journals fail closed without overwriting the record", async () => {
  const folder = await temporaryDirectory();
  const base = { ...intent, stageId: "work:stage", state: "pending" };
  for (const value of [
    null,
    {},
    { ...base, runId: "another" },
    { ...base, operationId: "another" },
    { ...base, inputDigest: "changed" },
    { ...base, leaseGeneration: "1" },
    { ...base, leaseGeneration: 0 },
    { ...base, leaseGeneration: 1.5 },
    { ...base, leaseGeneration: 2 },
    { ...base, stageId: "invalid stage" },
    { ...base, state: "other" },
  ]) {
    await writeRecord(folder, { name: "work-stage.json", value });
    const before = await readFile(join(folder, "work-stage.json"), "utf8");
    await assert.rejects(
      recordedWorkStage(intent, folder),
      /github-operation-stopped/,
    );
    assert.equal(
      await readFile(join(folder, "work-stage.json"), "utf8"),
      before,
    );
  }
});

await test("CLV-377 a committed release with a pending local journal gets a fresh guarded stage before executing", async () => {
  const folder = await temporaryDirectory();
  const authority = await openedAuthority(await temporaryDirectory(), {
    clock: () => noon,
    leaseLimits: () => ({ capacity: 2, queueLimit: 1, queueWorkingLimit: 1 }),
  });
  try {
    await start(authority, { runId: "merge" });
    const operation = await request(authority, {
      runId: "merge",
      capability: "github",
    });
    const identity = {
      runId: "merge",
      operationId: operation.operationId,
      inputDigest: operation.inputDigest,
      leaseGeneration: 1,
    };
    const work = stagePort(authority);
    const old = await recordedWorkStage(identity, folder);
    assert.equal((await work(old)).kind, "accepted");
    const left = await work({
      ...old,
      action: "leave",
      commandId: `${old.stageId}:leave`,
    });
    assert.equal(left.kind, "accepted");
    let checks = 0;
    const calls = capacityCalls(
      {
        gh: () => Promise.resolve(""),
        git: () => Promise.resolve(""),
        run: () => {
          checks++;
          return Promise.resolve("checked");
        },
      },
      {
        intent: { ...identity, method: "merge" },
        folder,
        signal: new AbortController().signal,
        work,
      },
    );
    assert.equal(await calls.run(["configured-check"], "."), "checked");
    assert.equal(checks, 1);
    const stages = (await authority.events()).filter(
      (event) => event.type === "operation.work-entered",
    );
    assert.equal(
      new Set(stages.map((event) => event.payload["stageId"])).size,
      2,
    );
    assert.equal((await authority.effects.budget("merge"))?.spent, 1);
  } finally {
    await authority.close();
  }
});
