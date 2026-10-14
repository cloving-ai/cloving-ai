import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { treeOf, withGithub } from "./github-worker-fixture.ts";

const examples = [
  "[Unmatched\nPrivate [Org](https://example.com)anization",
  'Private [Org](https://example.com "some ) title")anization',
  "Private [Org](<https://example.com/a)b>)anization",
  "[partial](https://example.com",
  "Private [Org](https://example.com/foo_(bar))anization",
  "Private [Org[an]](https://example.com)ization",
  "ghp\\_secret",
  "Private\\_Organ**ization**",
  "Private&#x20;Organization",
  "Private&unknown;Organization",
  "/opt/%fffile",
  "ghp_&#0;",
  "Priva**te**_Organization",
  "ghp**_**secret",
  "!/opt/private",
  "[Public source][link]\n\n[link]: javascript:alert(1)",
  '<a href="javascript:alert(1)">link</a>',
  "~/secrets",
  "PRIVATE ORGANIZATION",
  "Private **Organization**",
  "Private [Organization](https://example.com)",
  "Private&#32;Organization",
  "/opt/private",
  "C:\\private\\file",
  "C:/private/file",
  "\\\\server\\share",
  "../secret",
  "[file](file:///tmp/private)",
  "[path](/opt/private)",
  "[path](https://example.com/?path=%2Fopt%2Fprivate)",
  "[path](https://example.com/?path=..%2Fsecret)",
  "[link](ssh://example.com)",
  "name@example.com",
  "@private-user",
  "`@private-user`",
  "[person](https://github.com/@private-user)",
  "https://github.com/other/repository/issues/12",
  "https://github.com/other/repository/pull/12",
  "other/repository#12",
  ...[
    "ghp_",
    "gho_",
    "ghu_",
    "ghs_",
    "ghr_",
    "github_pat_",
    "sk-ant-",
    "-----BEGIN",
  ].map((prefix) => `${prefix}example`),
];

await test("CLV-075 refuses private text in raw, decoded and visible draft text", () =>
  withGithub(async (scene) => {
    const worker = scene.worker({
      privateTexts: ["Private Organization", "Private_Organization"],
    });
    await scene.perform(worker, { method: "prepare", payload: {} });
    const forbidden = [
      homedir(),
      scene.repository,
      scene.worktrees,
      ...examples,
    ];
    const reasons: unknown[] = [];
    for (const text of forbidden) {
      writeFileSync(join(treeOf(scene), "draft.md"), `# Draft\n${text}`);
      const result = await scene.perform(worker, {
        method: "create-issue",
        payload: { draft: "draft.md" },
      });
      reasons.push(result.reason);
    }
    assert.deepEqual(
      reasons,
      forbidden.map(() => "private-path-in-change"),
    );
    assert.ok(scene.state().calls.every((call) => call[0] !== "issue"));
  }));

await test("CLV-075 permits npm scopes, one-part routes, public sources and local issue references", () =>
  withGithub(async (scene) => {
    const worker = scene.worker({
      privateTexts: ["Private Organization", "Private_Organization"],
    });
    await scene.perform(worker, { method: "prepare", payload: {} });
    writeFileSync(
      join(treeOf(scene), "draft.md"),
      "# Public PRD\nUse @workflow/builders and /events. See #12, acme/demo#12, https://github.com/acme/demo/issues/12 and [sources](https://example.com/docs/costs(foo(bar))). [brackets] [unfinished ",
    );
    const result = await scene.perform(worker, {
      method: "create-issue",
      payload: { draft: "draft.md" },
    });
    assert.equal(result.outcome, "completed", JSON.stringify(result));
  }));

await test("CLV-075 requires the operator list independently of the home folder", () =>
  withGithub(async (scene) => {
    await scene.perform(scene.worker(), { method: "prepare", payload: {} });
    writeFileSync(join(treeOf(scene), "draft.md"), "# Draft\nPublic text");
    scene.plan({ scores: [], fail: "repo view" });
    for (const settings of [{}, { privateTexts: [] }, { privateTexts: [""] }]) {
      const result = await scene.perform(scene.worker(settings), {
        method: "create-issue",
        payload: { draft: "draft.md" },
      });
      assert.equal(result.reason, "private-texts-not-set");
    }
    assert.ok(scene.state().calls.every((call) => call[0] !== "issue"));
  }));

await test("CLV-075 reports missing and malformed drafts without a post", () =>
  withGithub(async (scene) => {
    const worker = scene.worker({ privateTexts: ["private"] });
    await scene.perform(worker, { method: "prepare", payload: {} });
    const call = { method: "create-issue", payload: { draft: "draft.md" } };
    assert.equal(
      (await scene.perform(worker, call)).reason,
      "draft-not-available",
    );
    for (const text of ["No heading", "# \nNo title", "## Wrong heading"]) {
      writeFileSync(join(treeOf(scene), "draft.md"), text);
      assert.equal((await scene.perform(worker, call)).reason, "invalid-draft");
    }
    assert.ok(scene.state().calls.every((call) => call[0] !== "issue"));
  }));
