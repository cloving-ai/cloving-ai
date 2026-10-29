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

await test("CLV-222 a capture fits the exact encoded worker result boundary", () =>
  withGithub(async (scene) => {
    const worker = scene.worker();
    await scene.perform(worker, { method: "prepare", payload: {} });
    const base = "# Draft\n" + '語😀"\\\n'.repeat(3000);
    const padding =
      65_536 - Buffer.byteLength(JSON.stringify({ text: base, digest }));
    const draft = base + "x".repeat(padding);
    writeFileSync(join(treeOf(scene), "draft.md"), draft);
    const captured = await scene.perform(worker, {
      method: "capture-draft",
      payload: { draft: "draft.md" },
    });
    assert.equal(captured.outcome, "completed");
    assert.equal(Buffer.byteLength(String(captured.result)), 65_536);
    assert.deepEqual(JSON.parse(String(captured.result)), {
      text: draft,
      digest: "sha256:" + createHash("sha256").update(draft).digest("hex"),
    });
    writeFileSync(join(treeOf(scene), "draft.md"), draft + "x");
    const oversized = await scene.perform(worker, {
      method: "capture-draft",
      payload: { draft: "draft.md" },
    });
    assert.equal(oversized.outcome, "failed");
    assert.equal(oversized.reason, "draft-too-large");
    assert.equal(oversized.result, undefined);
    assert.deepEqual(scene.state().calls, []);
  }));

await test("CLV-222 oversized Unicode and escaped captures persist a reportable failure", () =>
  withGithub(async (scene) => {
    const worker = scene.worker();
    await scene.perform(worker, { method: "prepare", payload: {} });
    for (const draft of ["語".repeat(22_000), '"\\\n'.repeat(12_000)]) {
      assert.ok(draft.length < 65_536);
      assert.ok(
        Buffer.byteLength(JSON.stringify({ text: draft, digest })) > 65_536,
      );
      writeFileSync(join(treeOf(scene), "draft.md"), draft);
      const captured = await scene.perform(worker, {
        method: "capture-draft",
        payload: { draft: "draft.md" },
      });
      assert.equal(captured.outcome, "failed");
      assert.equal(captured.reason, "draft-too-large");
      assert.equal(captured.result, undefined);
      writeFileSync(join(treeOf(scene), "draft.md"), text);
      const replay = await worker.reconcile(
        githubIntent({
          operationId: captured.operationId,
          method: "capture-draft",
        }),
        new AbortController().signal,
      );
      assert.equal(replay.kind, "failed");
      assert.equal(Reflect.get(replay, "reason"), "draft-too-large");
      assert.equal(Reflect.get(replay, "result"), undefined);
    }
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
