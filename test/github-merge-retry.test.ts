import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { git, resultOf, until } from "./claude-worker-fixture.ts";
import { githubIntent, opened, withGithub } from "./github-worker-fixture.ts";
import {
  advancedBase,
  mergeCalls,
  pausedMerge,
} from "./github-merge-fixture.ts";

await test("CLV-300 a merge retry in a new operation merges the head that the earlier attempt pushed", () =>
  withGithub(async (scene) => {
    const first = scene.worker({
      gh: pausedMerge(scene),
      check: [process.execPath, "-e", ""],
    });
    const commit = await opened(scene, first);
    advancedBase(scene);
    const paused = scene.worker({
      gh: pausedMerge(scene),
      check: [process.execPath, "-e", ""],
      document: () => Promise.resolve(JSON.stringify({ number: 1, commit })),
    });
    await paused.deliver(
      githubIntent({ method: "merge", operationId: "merge-paused" }),
      new AbortController().signal,
    );
    await until(() => existsSync(join(scene.directory, "paused")));
    await paused.close();
    await first.close();
    const updated = git(scene.origin, ["rev-parse", "cloving/ticket-one"]);
    assert.notEqual(updated, commit);
    const retry = scene.worker({
      check: [process.execPath, "-e", "process.exit(1)"],
    });
    const report = await scene.perform(retry, {
      method: "merge",
      payload: { number: 1, commit },
    });
    await retry.close();
    assert.equal(report.outcome, "completed", report.reason ?? "");
    assert.deepEqual(resultOf(report.result), {
      number: 1,
      commit,
      updated,
      merged: "f".repeat(40),
    });
    assert.equal(mergeCalls(scene).length, 1);
    assert.ok(mergeCalls(scene)[0]?.includes(`sha=${updated}`));
  }));
