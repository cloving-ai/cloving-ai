import assert from "node:assert/strict";
import { test } from "node:test";
import { withGithub } from "./github-worker-fixture.ts";

const identity = {
  owner: "acme",
  repository: "demo",
  number: 42,
  pullRequest: 7,
};
const body = "Original body.\n\n## Acceptance\nKeep this text.\n";
const original = {
  repository: "acme/demo",
  number: 42,
  state: "open",
  body,
  labels: ["keep", "cloving: in progress"],
};
const settings = { privateTexts: ["secret-project"] };

await test("CLV-123 protected completion closes with completed reason and fixed body text without a comment", () =>
  withGithub(async (scene) => {
    scene.plan({ scores: [], issues: [original] });
    const report = await scene.perform(scene.worker(settings), {
      method: "close-issue",
      payload: identity,
    });
    assert.equal(report.outcome, "completed", JSON.stringify(report));
    assert.deepEqual(scene.state().issues, [
      {
        ...original,
        state: "closed",
        state_reason: "completed",
        labels: ["keep"],
        body: `${body}\n## Cloving status\nCompleted in pull request #7.\n`,
      },
    ]);
    assert.equal(
      scene.state().calls.filter((call) => call.includes("PATCH")).length,
      1,
    );
    assert.ok(
      scene
        .state()
        .calls.every((call) => !call.some((part) => part.includes("comments"))),
    );
  }));

await test("CLV-123 partial runs preserve the body, append history and requeue the issue", () =>
  withGithub(async (scene) => {
    scene.plan({ scores: [], issues: [original] });
    const worker = scene.worker(settings);
    const first =
      "- Pull request #7: partial. Remaining: Add recovery.; Verify restart.";
    for (const pullRequest of [7, 8]) {
      const report = await scene.perform(worker, {
        method: "partial-issue",
        payload: {
          ...identity,
          pullRequest,
          remaining: ["Add recovery.", "Verify restart."],
        },
      });
      assert.equal(report.outcome, "completed", JSON.stringify(report));
      const expected =
        pullRequest === 7 ? first : `${first}\n${first.replace("#7", "#8")}`;
      assert.deepEqual(scene.state().issues, [
        {
          ...original,
          body: `${body}\n## Cloving status\n${expected}\n`,
          labels: ["keep", "cloving: ready"],
        },
      ]);
    }
  }));

await test("CLV-123 the third partial blocks instead of requeueing", () =>
  withGithub(async (scene) => {
    const earlier =
      "- Pull request #5: partial. Remaining: First.\n- Pull request #6: partial. Remaining: Second.";
    scene.plan({
      scores: [],
      issues: [
        {
          ...original,
          body: `${body}\n## Cloving status\n${earlier}\n`,
          labels: ["keep", "cloving: ready", "cloving: in progress"],
        },
      ],
    });
    const report = await scene.perform(scene.worker(settings), {
      method: "partial-issue",
      payload: { ...identity, remaining: ["Third."] },
    });
    assert.equal(report.outcome, "completed");
    assert.deepEqual(scene.state().issues[0]?.["labels"], [
      "keep",
      "cloving: blocked",
    ]);
    assert.equal(
      scene.state().issues[0]?.["body"],
      `${body}\n## Cloving status\n${earlier}\n- Pull request #7: partial. Remaining: Third.\n`,
    );
  }));

await test("CLV-123 privacy refusal replaces only the new remaining text with the fixed private-report notice", () =>
  withGithub(async (scene) => {
    for (const item of [
      "Fix /private/project/file.",
      "Remove secret-project.",
      "Ask person@example.invalid.",
    ]) {
      scene.plan({ scores: [], issues: [original] });
      const report = await scene.perform(scene.worker(settings), {
        method: "partial-issue",
        payload: { ...identity, remaining: [item] },
      });
      assert.equal(report.outcome, "completed");
      assert.equal(
        scene.state().issues[0]?.["body"],
        `${body}\n## Cloving status\n- Pull request #7: partial. Remaining: Remaining work is in the private run report.\n`,
      );
      assert.ok(
        scene
          .state()
          .calls.every((call) => !call.some((part) => part.includes(item))),
      );
    }
  }));

await test("CLV-123 completion preserves earlier partial history and removes queue labels", () =>
  withGithub(async (scene) => {
    const earlier = "- Pull request #5: partial. Remaining: Tests.";
    scene.plan({
      scores: [],
      issues: [
        {
          ...original,
          body: `${body}\n## Cloving status\n${earlier}\n`,
          labels: [
            "keep",
            "cloving: ready",
            "cloving: blocked",
            "cloving: in progress",
          ],
        },
      ],
    });
    const report = await scene.perform(scene.worker(settings), {
      method: "close-issue",
      payload: identity,
    });
    assert.equal(report.outcome, "completed");
    assert.deepEqual(scene.state().issues[0]?.["labels"], ["keep"]);
    assert.equal(
      scene.state().issues[0]?.["body"],
      `${body}\n## Cloving status\n${earlier}\nCompleted in pull request #7.\n`,
    );
  }));

await test("CLV-123 an unconfigured privacy check writes the fixed notice", () =>
  withGithub(async (scene) => {
    scene.plan({ scores: [], issues: [original] });
    const report = await scene.perform(scene.worker(), {
      method: "partial-issue",
      payload: { ...identity, remaining: ["Still private."] },
    });
    assert.equal(report.outcome, "completed");
    assert.match(
      String(scene.state().issues[0]?.["body"]),
      /Remaining: Remaining work is in the private run report\./,
    );
  }));
