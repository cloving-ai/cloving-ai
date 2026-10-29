import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { githubIntent, treeOf, withGithub } from "./github-worker-fixture.ts";
import { methods } from "../src/daemon/github-methods.ts";

const text = "# Run costs\n\n## Problem\nShow the cost.\n";
const digest = "sha256:" + createHash("sha256").update(text).digest("hex");

await test("CLV-222 exposes capture-draft as a protected GitHub method", () => {
  assert.ok(methods.has("capture-draft"));
});

await test("CLV-222 a protected capture records the exact draft and its digest", () =>
  withGithub(async (scene) => {
    const worker = scene.worker({ privateTexts: ["private organization"] });
    await scene.perform(worker, { method: "prepare", payload: {} });
    writeFileSync(join(treeOf(scene), "draft.md"), text);
    const intent = { method: "capture-draft", payload: { draft: "draft.md" } };
    const captured = await scene.perform(worker, intent);
    assert.equal(captured.outcome, "completed", JSON.stringify(captured));
    assert.deepEqual(JSON.parse(String(captured.result)), { text, digest });
    writeFileSync(join(treeOf(scene), "draft.md"), "# Changed\nOther text");
    const replay = await worker.reconcile(
      githubIntent({
        operationId: captured.operationId,
        method: "capture-draft",
      }),
      new AbortController().signal,
    );
    assert.ok(replay.kind === "completed");
    assert.equal(replay.result, captured.result);
    assert.deepEqual(scene.state().calls, []);
  }));

await test("CLV-222 the checked post accepts every matching reviewed digest", () =>
  withGithub(async (scene) => {
    const worker = scene.worker({ privateTexts: ["private organization"] });
    await scene.perform(worker, { method: "prepare", payload: {} });
    writeFileSync(join(treeOf(scene), "draft.md"), text);
    const posted = await scene.perform(worker, {
      method: "create-issue",
      payload: { draft: "draft.md", expectedDigests: [digest, digest] },
    });
    assert.equal(posted.outcome, "completed", JSON.stringify(posted));
    assert.equal(
      scene.state().calls.filter((call) => call[0] === "issue").length,
      1,
    );
  }));

await test("CLV-222 a changed draft refuses a person review or post approval digest before any GitHub call", () =>
  withGithub(async (scene) => {
    const worker = scene.worker({ privateTexts: ["private organization"] });
    await scene.perform(worker, { method: "prepare", payload: {} });
    const changed = text + "Changed.\n";
    writeFileSync(join(treeOf(scene), "draft.md"), changed);
    const current =
      "sha256:" + createHash("sha256").update(changed).digest("hex");
    for (const expectedDigests of [
      [digest],
      [digest, digest],
      [digest, current],
      [current, digest],
    ]) {
      const posted = await scene.perform(worker, {
        method: "create-issue",
        payload: { draft: "draft.md", expectedDigests },
      });
      assert.equal(posted.reason, "draft-changed");
    }
    assert.deepEqual(scene.state().calls, []);
  }));

await test("CLV-222 malformed digest constraints never fall back to an unchecked post", () =>
  withGithub(async (scene) => {
    const worker = scene.worker({ privateTexts: ["private organization"] });
    await scene.perform(worker, { method: "prepare", payload: {} });
    writeFileSync(join(treeOf(scene), "draft.md"), text);
    for (const expectedDigests of [
      null,
      [],
      "digest",
      [null],
      [""],
      [digest, 1],
    ]) {
      const posted = await scene.perform(worker, {
        method: "create-issue",
        payload: { draft: "draft.md", expectedDigests },
      });
      assert.equal(
        posted.reason,
        "invalid-payload",
        JSON.stringify(expectedDigests),
      );
    }
    assert.deepEqual(scene.state().calls, []);
  }));
