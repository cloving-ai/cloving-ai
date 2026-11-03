import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { inMergeTurn } from "../src/daemon/merge-turns.ts";
import { mergeCalls } from "./github-merge-fixture.ts";
import { opened, withGithub } from "./github-worker-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

await test("CLV-280 a merge step waits while the merge turn of its repository is held", () =>
  withGithub(async (scene) => {
    const worker = scene.worker();
    const commit = await opened(scene, worker);
    const held = Promise.withResolvers<undefined>();
    const holder = inMergeTurn(
      { repository: scene.repository, signal: new AbortController().signal },
      () => held.promise,
    );
    const merging = scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    const early = await Promise.race([
      merging.then(() => "reported"),
      delay(testMilliseconds(3000)).then(() => "waiting"),
    ]);
    assert.equal(early, "waiting");
    assert.deepEqual(mergeCalls(scene), []);
    assert.equal(scene.state().prs[0]?.["state"], "OPEN");
    held.resolve(undefined);
    await holder;
    const report = await merging;
    assert.equal(report.outcome, "completed", report.reason ?? "");
    assert.equal(scene.state().prs[0]?.["state"], "MERGED");
  }));
