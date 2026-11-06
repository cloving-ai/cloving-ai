import assert from "node:assert/strict";
import { test } from "node:test";
import { treeSweep } from "../src/daemon/tree-sweep.ts";
import { running, withTrees } from "./tree-sweep-fixture.ts";

await test("CLV-310 the sweep gives up a GitHub read after its deadline and keeps the work tree", () =>
  withTrees(async (scene) => {
    await scene.tree("ticket/slow", [{ kind: "journal", runId: "failedOld" }]);
    const started = performance.now();
    await treeSweep(scene.settings({ readMilliseconds: 200 })).pass(running);
    assert.ok(performance.now() - started < 10_000);
    assert.equal(scene.kept("ticket/slow"), true);
    assert.match(
      scene.lines[0] ?? "",
      /, failed 1 \(ticket\/slow: github-call-failed/,
    );
  }));

await test("CLV-310 a stop cancels a pending GitHub read of the sweep and checks no other work tree", () =>
  withTrees(async (scene) => {
    for (const target of ["ticket/a-slow", "ticket/b-slow"])
      await scene.tree(target, [{ kind: "journal", runId: "failedOld" }]);
    const stopping = new AbortController();
    const started = performance.now();
    const pass = treeSweep(scene.settings()).pass(stopping.signal);
    setTimeout(() => {
      stopping.abort();
    }, 300);
    await pass;
    assert.ok(performance.now() - started < 10_000);
    assert.equal(scene.kept("ticket/a-slow"), true);
    assert.equal(scene.kept("ticket/b-slow"), true);
    assert.match(
      scene.lines[0] ?? "",
      /, failed 1 \(ticket\/a-slow: github-call-failed/,
    );
  }));

await test("CLV-310 the sweep checks at most three work trees in one pass and goes on with the others in the next pass", () =>
  withTrees(async (scene) => {
    for (const target of ["ticket/a", "ticket/b", "ticket/c", "ticket/d"])
      await scene.tree(target, [{ kind: "journal", runId: "failedOld" }]);
    const sweep = treeSweep(scene.settings());
    await sweep.pass(running);
    assert.equal(scene.kept("ticket/d"), true);
    await sweep.pass(running);
    for (const target of ["ticket/a", "ticket/b", "ticket/c", "ticket/d"])
      assert.equal(scene.gone(target), true, target);
    assert.deepEqual(scene.lines, [
      "retention: removed 3 work trees, kept 0 with an open pull request\n",
      "retention: removed 1 work trees, kept 0 with an open pull request\n",
    ]);
  }));
