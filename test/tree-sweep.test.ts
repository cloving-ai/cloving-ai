import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { operationKey } from "../src/daemon/operation-journal.ts";
import { treeSweep } from "../src/daemon/tree-sweep.ts";
import { day, git, running, withTrees } from "./tree-sweep-fixture.ts";

await test("CLV-310 the sweep removes the work tree, branch and attachments of an old failed or cancelled run with no open pull request", () =>
  withTrees(async (scene) => {
    await scene.tree("ticket/failed", [
      { kind: "journal", runId: "failedOld" },
    ]);
    await scene.tree("ticket/cancelled", [
      { kind: "journal", runId: "cancelledOld" },
      { kind: "github", runId: "cancelledOld" },
    ]);
    await scene.tree("ticket/failed-open", [
      { kind: "journal", runId: "failedOld" },
    ]);
    await treeSweep(scene.settings()).pass(running);
    assert.equal(scene.gone("ticket/failed"), true);
    assert.equal(scene.gone("ticket/cancelled"), true);
    assert.equal(scene.kept("ticket/failed-open"), true);
    assert.deepEqual(scene.lines, [
      "retention: removed 2 work trees, kept 1 with an open pull request\n",
    ]);
    assert.doesNotMatch(
      git(scene.repository, ["worktree", "list"]),
      /ticket-(failed|cancelled) /,
    );
  }));

await test("CLV-310 the sweep keeps the work trees of recent, completed, active and unknown runs", () =>
  withTrees(async (scene) => {
    await scene.tree("ticket/recent", [
      { kind: "journal", runId: "failedRecent" },
    ]);
    await scene.tree("ticket/completed", [
      { kind: "journal", runId: "completedOld" },
    ]);
    await scene.tree("ticket/retried", [
      { kind: "journal", runId: "failedOld" },
      { kind: "github", runId: "active" },
    ]);
    await scene.tree("ticket/unknown", [{ kind: "journal", runId: "missing" }]);
    await scene.tree("ticket/none", []);
    await treeSweep(scene.settings()).pass(running);
    for (const target of [
      "ticket/recent",
      "ticket/completed",
      "ticket/retried",
      "ticket/unknown",
      "ticket/none",
    ])
      assert.equal(scene.kept(target), true, target);
    assert.deepEqual(scene.lines, [
      "retention: removed 0 work trees, kept 0 with an open pull request\n",
    ]);
  }));

await test("CLV-310 the sweep keeps a work tree when the pull request check fails, and keeps all with retention.days null", () =>
  withTrees(async (scene) => {
    await scene.tree("ticket/broken", [
      { kind: "journal", runId: "failedOld" },
    ]);
    await treeSweep(scene.settings()).pass(running);
    assert.equal(scene.kept("ticket/broken"), true);
    assert.equal(scene.lines.length, 1);
    assert.match(
      scene.lines[0] ?? "",
      /^retention: removed 0 work trees, kept 0 with an open pull request, failed 1 \(ticket\/broken: github-call-failed.*\)\n$/,
    );
    await scene.tree("ticket/failed", [
      { kind: "journal", runId: "failedOld" },
    ]);
    await treeSweep(
      scene.settings({
        retention: { days: null, action: "archive", archiveFolder: null },
      }),
    ).pass(running);
    assert.equal(scene.kept("ticket/failed"), true);
    assert.equal(scene.lines.length, 1);
  }));

await test("CLV-310 the sweep skips branch targets, records with no run and records with no work tree, and keeps a tree on an invalid GitHub reply", () =>
  withTrees(async (scene) => {
    await scene.tree("ticket/odd", [{ kind: "journal", runId: "failedOld" }]);
    const raw = async (name: string, text: string) => {
      await mkdir(join(scene.state, "journal", name), { recursive: true });
      await writeFile(join(scene.state, "journal", name, "started.json"), text);
    };
    await raw("invalid", "{");
    await raw("empty", "null");
    await raw("no-run", JSON.stringify({ target: "ticket/odd" }));
    await raw(
      "branch",
      JSON.stringify({ target: "branch:feature", runId: "failedOld" }),
    );
    await raw(
      "removed",
      JSON.stringify({ target: "ticket/removed", runId: "failedOld" }),
    );
    await treeSweep(scene.settings()).pass(running);
    assert.equal(scene.kept("ticket/odd"), true);
    assert.deepEqual(scene.lines, [
      "retention: removed 0 work trees, kept 0 with an open pull request, failed 1 (ticket/odd: github-reply-invalid)\n",
    ]);
  }));

await test("CLV-310 a work tree pass that fails logs the reason", () =>
  withTrees(async (scene) => {
    await scene.tree("ticket/failed", [
      { kind: "journal", runId: "failedOld" },
    ]);
    await treeSweep(
      scene.settings({
        runs: () => Promise.reject(new Error("authority-closed")),
      }),
    ).pass(running);
    assert.equal(scene.kept("ticket/failed"), true);
    assert.deepEqual(scene.lines, [
      "retention: work trees failed (authority-closed)\n",
    ]);
  }));

await test("CLV-310 the sweep keeps a work tree that a completed run used after the records of that run move to the archive", () =>
  withTrees(async (scene) => {
    await scene.tree("ticket/mixed", [
      { kind: "journal", runId: "completedOld" },
      { kind: "github", runId: "failedRecent" },
    ]);
    await treeSweep(scene.settings()).pass(running);
    await scene.archive("completedOld");
    await treeSweep(scene.settings({ now: () => scene.now + 30 * day })).pass(
      running,
    );
    assert.equal(scene.kept("ticket/mixed"), true);
    assert.deepEqual(scene.lines, [
      "retention: removed 0 work trees, kept 0 with an open pull request\n",
      "retention: removed 0 work trees, kept 0 with an open pull request\n",
    ]);
  }));

await test("CLV-310 the sweep forgets the runs of a work tree that is gone, so a new work tree of the target counts only its own runs", () =>
  withTrees(async (scene) => {
    await scene.tree("ticket/again", [
      { kind: "journal", runId: "completedOld" },
    ]);
    await treeSweep(scene.settings()).pass(running);
    await scene.merged("ticket/again");
    await scene.archive("completedOld");
    await treeSweep(scene.settings()).pass(running);
    await scene.tree("ticket/again", [{ kind: "journal", runId: "failedOld" }]);
    await treeSweep(scene.settings()).pass(running);
    assert.equal(scene.gone("ticket/again"), true);
  }));

await test("CLV-310 the sweep keeps the work trees of run lists that it cannot read or that have run IDs that are not text", () =>
  withTrees(async (scene) => {
    await scene.tree("ticket/listed", [
      { kind: "journal", runId: "failedOld" },
    ]);
    await scene.tree("ticket/only-list", []);
    await scene.tree("ticket/plain", [{ kind: "journal", runId: "failedOld" }]);
    const folder = join(scene.state, "journal", "trees");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "broken.json"), "{");
    await writeFile(join(folder, "empty.json"), "null");
    await writeFile(join(folder, "staged.json.staged"), "{");
    await writeFile(
      join(folder, "listed.json"),
      JSON.stringify({ target: "ticket/listed", runIds: "completedOld" }),
    );
    await writeFile(
      join(folder, "only-list.json"),
      JSON.stringify({ target: "ticket/only-list", runIds: ["failedOld", 7] }),
    );
    await treeSweep(scene.settings()).pass(running);
    assert.equal(scene.kept("ticket/listed"), true);
    assert.equal(scene.kept("ticket/only-list"), true);
    assert.equal(scene.gone("ticket/plain"), true);
    assert.deepEqual(scene.lines, [
      "retention: removed 1 work trees, kept 0 with an open pull request, failed 2 (ticket/listed: tree-runs-unreadable)\n",
    ]);
  }));

await test("CLV-310 the sweep keeps a work tree and does not replace its run list when it cannot read the list", () =>
  withTrees(async (scene) => {
    await scene.tree("ticket/unread", [
      { kind: "journal", runId: "completedOld" },
      { kind: "github", runId: "failedOld" },
    ]);
    await treeSweep(scene.settings()).pass(running);
    await scene.archive("completedOld");
    const list = join(
      scene.state,
      "journal",
      "trees",
      `${operationKey("ticket/unread")}.json`,
    );
    await writeFile(list, "{");
    await treeSweep(scene.settings()).pass(running);
    assert.equal(scene.kept("ticket/unread"), true);
    assert.equal(await readFile(list, "utf8"), "{");
    assert.deepEqual(scene.lines.slice(1), [
      "retention: removed 0 work trees, kept 0 with an open pull request, failed 1 (ticket/unread: tree-runs-unreadable)\n",
    ]);
  }));

await test("CLV-310 a pass that cannot read the folder of run lists removes no work tree", () =>
  withTrees(async (scene) => {
    await scene.tree("ticket/failed", [
      { kind: "journal", runId: "failedOld" },
    ]);
    await mkdir(join(scene.state, "journal"), { recursive: true });
    await writeFile(join(scene.state, "journal", "trees"), "");
    await treeSweep(scene.settings()).pass(running);
    assert.equal(scene.kept("ticket/failed"), true);
    assert.deepEqual(scene.lines, ["retention: work trees failed (ENOTDIR)\n"]);
  }));

await test("CLV-310 the sweep counts only the runs that did not end before the work tree was made, so a replacement work tree expires", () =>
  withTrees(async (scene) => {
    await scene.tree("ticket/replaced", [
      { kind: "journal", runId: "completedOld" },
    ]);
    await treeSweep(scene.settings()).pass(running);
    await scene.merged("ticket/replaced");
    await scene.tree("ticket/replaced", [
      { kind: "journal", runId: "failedAgain" },
    ]);
    await scene.born("ticket/replaced", scene.now - 38 * day);
    await treeSweep(scene.settings()).pass(running);
    assert.equal(scene.gone("ticket/replaced"), true);
  }));

await test("CLV-310 the sweep keeps a work tree folder that has no git link", () =>
  withTrees(async (scene) => {
    const path = await scene.tree("ticket/unlinked", [
      { kind: "journal", runId: "failedOld" },
    ]);
    await rm(join(path, ".git"));
    await treeSweep(scene.settings()).pass(running);
    assert.equal(scene.kept("ticket/unlinked"), true);
    assert.deepEqual(scene.lines, [
      "retention: removed 0 work trees, kept 0 with an open pull request\n",
    ]);
  }));
