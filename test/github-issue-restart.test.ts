import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { located } from "../src/daemon/operation-journal.ts";
import { git, until } from "./claude-worker-fixture.ts";
import {
  githubIntent,
  treeOf,
  withGithub,
  type GithubScene,
} from "./github-worker-fixture.ts";

const marker = "<!-- cloving-prd:ticket/one -->";
const settings = { privateTexts: ["private"] };

function restartRecord(scene: GithubScene): void {
  const folder = located(scene.journal, "operation-post").folder;
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, "started.json"),
    JSON.stringify({
      ...githubIntent({
        operationId: "operation-post",
        method: "create-issue",
      }),
      payloadText: JSON.stringify({ draft: "draft.md" }),
    }),
  );
  writeFileSync(join(folder, "post.json"), JSON.stringify({ marker }));
}

await test("CLV-075 a restarted post without a remote marker is uncertain and cannot post again", () =>
  withGithub(async (scene) => {
    const first = scene.worker(settings);
    await scene.perform(first, { method: "prepare", payload: {} });
    writeFileSync(
      join(treeOf(scene), "draft.md"),
      "# Draft\nPublic description",
    );
    await first.close();
    restartRecord(scene);
    scene.worker(settings);
    await until(() =>
      scene.reports.some((report) => report.operationId === "operation-post"),
    );
    const report = scene.reports.find(
      (report) => report.operationId === "operation-post",
    );
    assert.equal(report?.reason, "post-uncertain");
    assert.ok(scene.state().calls.every((call) => call[0] !== "issue"));
    assert.ok(existsSync(treeOf(scene)));
  }));

await test("CLV-075 pagination reconciles a closed issue on the second page before a recorded post", () =>
  withGithub(async (scene) => {
    const first = scene.worker(settings);
    await scene.perform(first, { method: "prepare", payload: {} });
    writeFileSync(
      join(treeOf(scene), "draft.md"),
      "# Draft\nPublic description",
    );
    await first.close();
    restartRecord(scene);
    scene.plan({
      scores: [],
      issuePages: [
        [{ number: 1, body: "unrelated" }],
        [
          {
            number: 75,
            html_url: "https://github.com/acme/demo/issues/75",
            state: "closed",
            body: marker,
          },
        ],
      ],
    });
    scene.worker(settings);
    await until(() =>
      scene.reports.some((report) => report.operationId === "operation-post"),
    );
    const report = scene.reports.find(
      (report) => report.operationId === "operation-post",
    );
    assert.deepEqual(JSON.parse(String(report?.result)), {
      number: 75,
      url: "https://github.com/acme/demo/issues/75",
    });
    assert.ok(
      scene
        .state()
        .calls.some(
          (call) =>
            call.includes("--paginate") &&
            call.includes("--jq") &&
            call.some((part) => part.includes("state=all")),
        ),
    );
    assert.ok(scene.state().calls.every((call) => call[0] !== "issue"));
  }));

await test("CLV-075 searches histories larger than the subprocess buffer and returns only matching issue identities", () =>
  withGithub(async (scene) => {
    const worker = scene.worker(settings);
    await scene.perform(worker, { method: "prepare", payload: {} });
    writeFileSync(join(treeOf(scene), "draft.md"), "# Draft\nPublic text");
    const page = Array.from({ length: 100 }, (_, index) => ({
      number: index + 1,
      body: "x".repeat(60_000),
    }));
    const call = { method: "create-issue", payload: { draft: "draft.md" } };
    for (const body of [null, `${"x".repeat(60_000)}${marker}`]) {
      scene.plan({
        scores: [],
        issuePages: [
          page,
          page,
          page,
          [
            {
              number: 75,
              html_url: "https://github.com/acme/demo/issues/75",
              body,
            },
          ],
        ],
      });
      const report = await scene.perform(worker, call);
      assert.equal(report.outcome, "completed", JSON.stringify(report));
      const number = body === null ? 1 : 75;
      assert.deepEqual(JSON.parse(String(report.result)), {
        number,
        url: `https://github.com/acme/demo/issues/${String(number)}`,
      });
    }
    assert.equal(
      scene.state().calls.filter((call) => call[0] === "issue").length,
      1,
    );
  }));

await test("CLV-075 records the intent before even a failed post", () =>
  withGithub(async (scene) => {
    const worker = scene.worker(settings);
    await scene.perform(worker, { method: "prepare", payload: {} });
    writeFileSync(
      join(treeOf(scene), "draft.md"),
      "# Draft\nPublic description",
    );
    scene.plan({ scores: [], fail: "issue create" });
    const report = await scene.perform(worker, {
      method: "create-issue",
      payload: { draft: "draft.md" },
    });
    assert.equal(report.reason, "github-call-failed");
    assert.ok(
      existsSync(
        join(located(scene.journal, report.operationId).folder, "post.json"),
      ),
    );
  }));

await test("CLV-075 discard removes an uncommitted draft, work tree and local branch idempotently", () =>
  withGithub(async (scene) => {
    const worker = scene.worker();
    await scene.perform(worker, { method: "prepare", payload: {} });
    writeFileSync(join(treeOf(scene), "draft.md"), "# Draft");
    const first = await scene.perform(worker, {
      method: "discard",
      payload: {},
    });
    assert.equal(first.outcome, "completed");
    assert.equal(existsSync(treeOf(scene)), false);
    assert.equal(
      git(scene.repository, ["branch", "--list", "cloving/ticket-one"]),
      "",
    );
    assert.equal(
      (await scene.perform(worker, { method: "discard", payload: {} })).outcome,
      "completed",
    );
    assert.deepEqual(scene.state().calls, []);
  }));
