import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { treeOf, withGithub } from "./github-worker-fixture.ts";

await test("CLV-075 create-issue posts the draft once with a cycle marker", () =>
  withGithub(async (scene) => {
    const worker = scene.worker({ privateTexts: ["private organization"] });
    await scene.perform(worker, { method: "prepare", payload: {} });
    writeFileSync(
      join(treeOf(scene), "draft.md"),
      "# Run costs\n\n## Problem\nShow the cost.\n",
    );
    const intent = { method: "create-issue", payload: { draft: "draft.md" } };
    const first = await scene.perform(worker, intent);
    assert.equal(first.outcome, "completed", JSON.stringify(first));
    assert.deepEqual(JSON.parse(String(first.result)), {
      number: 1,
      url: "https://github.com/acme/demo/issues/1",
    });
    assert.equal((await scene.perform(worker, intent)).result, first.result);
    const creates = scene
      .state()
      .calls.filter((call) => call[0] === "issue" && call[1] === "create");
    assert.equal(creates.length, 1);
    const [created = []] = creates;
    assert.equal(created[created.indexOf("--title") + 1], "Run costs");
    assert.equal(
      created[created.indexOf("--body") + 1],
      "\n## Problem\nShow the cost.\n\n<!-- cloving-prd:ticket/one -->",
    );
    assert.ok(!created.includes("--label"));
  }));

await test("CLV-075 rejects malformed repository replies before searching or posting", () =>
  withGithub(async (scene) => {
    const worker = scene.worker({ privateTexts: ["private"] });
    await scene.perform(worker, { method: "prepare", payload: {} });
    writeFileSync(join(treeOf(scene), "draft.md"), "# Draft\nPublic text");
    for (const reply of [
      null,
      [],
      {},
      75,
      { nameWithOwner: 75 },
      { nameWithOwner: "" },
      { nameWithOwner: "demo" },
    ]) {
      scene.plan({ scores: [], replies: { "repo view": reply } });
      const report = await scene.perform(worker, {
        method: "create-issue",
        payload: { draft: "draft.md" },
      });
      assert.equal(report.reason, "github-call-failed", JSON.stringify(reply));
    }
    assert.ok(scene.state().calls.every((call) => call[0] === "repo"));
  }));

await test("CLV-075 rejects malformed matched issues instead of returning coerced identities", () =>
  withGithub(async (scene) => {
    const worker = scene.worker({ privateTexts: ["private"] });
    await scene.perform(worker, { method: "prepare", payload: {} });
    writeFileSync(join(treeOf(scene), "draft.md"), "# Draft\nPublic text");
    const valid = {
      number: 75,
      html_url: "https://github.com/acme/demo/issues/75",
    };
    const invalid = [
      {},
      { html_url: valid.html_url },
      ...[null, "75", 0, -1, 1.5, 9007199254740992].map((number) => ({
        ...valid,
        number,
      })),
      ...[
        undefined,
        null,
        75,
        "",
        "not a url",
        "file:///issues/75",
        "https://github.com/acme/demo/issues/76",
      ].map((html_url) => ({ ...valid, html_url })),
    ];
    for (const reply of invalid) {
      scene.plan({
        scores: [],
        issuePages: [[{ ...reply, body: "<!-- cloving-prd:ticket/one -->" }]],
      });
      const report = await scene.perform(worker, {
        method: "create-issue",
        payload: { draft: "draft.md" },
      });
      assert.equal(report.reason, "github-call-failed", JSON.stringify(reply));
    }
    for (const reply of ["null", "[null]", '[{"number":75}]']) {
      scene.plan({ scores: [], replies: { "api GET issues": reply } });
      const report = await scene.perform(worker, {
        method: "create-issue",
        payload: { draft: "draft.md" },
      });
      assert.equal(report.reason, "github-call-failed", reply);
    }
    assert.ok(scene.state().calls.every((call) => call[0] !== "issue"));
  }));

await test("CLV-075 rejects invalid issue creation links", () =>
  withGithub(async (scene) => {
    const worker = scene.worker({ privateTexts: ["private"] });
    await scene.perform(worker, { method: "prepare", payload: {} });
    writeFileSync(join(treeOf(scene), "draft.md"), "# Draft\nPublic text");
    for (const reply of [
      "https://github.com/acme/demo/issues/0",
      "file:///issues/75",
      "not a url/issues/75",
    ]) {
      scene.plan({ scores: [], replies: { "issue create": reply } });
      const report = await scene.perform(worker, {
        method: "create-issue",
        payload: { draft: "draft.md" },
      });
      assert.equal(report.reason, "github-call-failed", reply);
    }
  }));

await test("CLV-075 draft input stays at the work tree root and must be a regular file", () =>
  withGithub(async (scene) => {
    const worker = scene.worker({ privateTexts: ["private"] });
    await scene.perform(worker, { method: "prepare", payload: {} });
    mkdirSync(join(treeOf(scene), "directory.md"));
    symlinkSync(
      join(scene.repository, "README.md"),
      join(treeOf(scene), "linked.md"),
    );
    for (const draft of ["../README.md", "folder\\draft.md"])
      assert.equal(
        (
          await scene.perform(worker, {
            method: "create-issue",
            payload: { draft },
          })
        ).reason,
        "invalid-draft",
      );
    for (const draft of ["directory.md", "linked.md"])
      assert.equal(
        (
          await scene.perform(worker, {
            method: "create-issue",
            payload: { draft },
          })
        ).reason,
        "draft-not-available",
      );
    assert.equal(
      (await scene.perform(worker, { method: "create-issue", payload: {} }))
        .reason,
      "invalid-payload",
    );
    assert.deepEqual(scene.state().calls, []);
  }));

await test("CLV-075 an unavailable work tree and malformed GitHub replies cannot produce an issue result", () =>
  withGithub(async (scene) => {
    const worker = scene.worker({ privateTexts: ["private"] });
    const call = { method: "create-issue", payload: { draft: "draft.md" } };
    assert.equal(
      (await scene.perform(worker, call)).reason,
      "work-tree-not-available",
    );
    await scene.perform(worker, { method: "prepare", payload: {} });
    writeFileSync(join(treeOf(scene), "draft.md"), "# Draft\nPublic text");
    scene.plan({ scores: [], garble: "api GET issues" });
    assert.equal(
      (await scene.perform(worker, call)).reason,
      "github-call-failed",
    );
    assert.ok(scene.state().calls.every((call) => call[0] !== "issue"));
    scene.plan({ scores: [], garble: "issue create" });
    assert.equal(
      (await scene.perform(worker, call)).reason,
      "github-call-failed",
    );
  }));
