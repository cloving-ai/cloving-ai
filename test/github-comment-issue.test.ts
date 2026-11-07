import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { methods } from "../src/daemon/github-methods.ts";
import { located } from "../src/daemon/operation-journal.ts";
import { until } from "./claude-worker-fixture.ts";
import {
  githubIntent,
  withGithub,
  type GithubScene,
} from "./github-worker-fixture.ts";

const settings = { privateTexts: ["Private Organization"] };

function comments(scene: GithubScene): readonly (readonly string[])[] {
  return scene
    .state()
    .calls.filter((call) => call[0] === "issue" && call[1] === "comment");
}

await test("CLV-319 comment-issue posts the reply on the issue once with a marker of the operation", () =>
  withGithub(async (scene) => {
    assert.ok(methods.has("comment-issue"));
    scene.plan({ scores: [] });
    const worker = scene.worker(settings);
    const body = "Same error as #599. See src/daemon/reload.ts:42.";
    const report = await scene.perform(worker, {
      method: "comment-issue",
      payload: { number: 639, body },
    });
    assert.equal(report.outcome, "completed", JSON.stringify(report));
    assert.deepEqual(JSON.parse(String(report.result)), {
      number: 639,
      url: "https://github.com/acme/demo/issues/639#issuecomment-1",
    });
    const marker = `<!-- cloving-comment:${located(scene.journal, "operation-1").key} -->`;
    assert.deepEqual(comments(scene), [
      ["issue", "comment", "639", "--body", `${body}\n${marker}`],
    ]);
  }));

await test("CLV-319 comment-issue refuses a local path, private text or a bad payload before any comment", () =>
  withGithub(async (scene) => {
    scene.plan({ scores: [] });
    const worker = scene.worker(settings);
    const reasons: unknown[] = [];
    for (const payload of [
      { number: 639, body: `The log is in ${scene.repository}/run.log.` },
      { number: 639, body: "See /opt/private/run.log." },
      { number: 639, body: "Asked by Private Organization." },
      { number: 639, body: "Thanks @visitor." },
      { number: 639, body: "" },
      { number: 639, body: " \n " },
      { number: 0, body: "Reply" },
      { number: "639", body: "Reply" },
    ])
      reasons.push(
        (await scene.perform(worker, { method: "comment-issue", payload }))
          .reason,
      );
    const unset = scene.worker({ privateTexts: [" "] });
    reasons.push(
      (
        await scene.perform(unset, {
          method: "comment-issue",
          payload: { number: 639, body: "Reply" },
        })
      ).reason,
    );
    assert.deepEqual(reasons, [
      "private-path-in-change",
      "private-path-in-change",
      "private-path-in-change",
      "private-path-in-change",
      "invalid-payload",
      "invalid-payload",
      "invalid-payload",
      "invalid-payload",
      "private-texts-not-set",
    ]);
    assert.deepEqual(comments(scene), []);
  }));

function restartedComment(scene: GithubScene): string {
  const { key, folder } = located(scene.journal, "operation-comment");
  const marker = `<!-- cloving-comment:${key} -->`;
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, "started.json"),
    JSON.stringify(
      Object.assign(
        githubIntent({
          operationId: "operation-comment",
          method: "comment-issue",
        }),
        { payloadText: JSON.stringify({ number: 639, body: "Reply" }) },
      ),
    ),
  );
  writeFileSync(join(folder, "post.json"), JSON.stringify({ marker }));
  return marker;
}

async function restartReport(scene: GithubScene) {
  scene.worker(settings);
  await until(() =>
    scene.reports.some((report) => report.operationId === "operation-comment"),
  );
  return scene.reports.find(
    (report) => report.operationId === "operation-comment",
  );
}

await test("CLV-319 a restarted comment-issue finds its marked comment and does not post again", () =>
  withGithub(async (scene) => {
    const marker = restartedComment(scene);
    const url = "https://github.com/acme/demo/issues/639#issuecomment-7";
    scene.plan({
      scores: [],
      issueComments: [
        {
          id: 6,
          issue: 639,
          body: "Other reply",
          html_url: "https://github.com/acme/demo/issues/639#issuecomment-6",
        },
        { id: 7, issue: 639, body: `Reply\n${marker}`, html_url: url },
      ],
    });
    const report = await restartReport(scene);
    assert.equal(report?.outcome, "completed", JSON.stringify(report));
    assert.deepEqual(JSON.parse(String(report.result)), { number: 639, url });
    assert.deepEqual(comments(scene), []);
  }));

await test("CLV-319 a restarted comment-issue without its marked comment is uncertain and does not post", () =>
  withGithub(async (scene) => {
    restartedComment(scene);
    scene.plan({ scores: [] });
    const report = await restartReport(scene);
    assert.equal(report?.reason, "post-uncertain");
    assert.deepEqual(comments(scene), []);
  }));

await test("CLV-319 comment-issue fails with github-call-failed on an unexpected gh answer", () =>
  withGithub(async (scene) => {
    const worker = scene.worker(settings);
    const reasons: unknown[] = [];
    for (const replies of [
      {
        "issue comment":
          "https://github.com/acme/demo/issues/640#issuecomment-1",
      },
      { "issue comment": "Created" },
      { "api GET comments": { url: "comment" } },
      { "api GET comments": [5] },
    ]) {
      scene.plan({ scores: [], replies });
      reasons.push(
        (
          await scene.perform(worker, {
            method: "comment-issue",
            payload: { number: 639, body: "Reply" },
          })
        ).reason,
      );
    }
    assert.deepEqual(reasons, [
      "github-call-failed",
      "github-call-failed",
      "github-call-failed",
      "github-call-failed",
    ]);
  }));
