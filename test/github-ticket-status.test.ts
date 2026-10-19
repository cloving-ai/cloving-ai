import assert from "node:assert/strict";
import { test } from "node:test";
import { statusBody, withGithub } from "./github-worker-fixture.ts";

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
        body: statusBody(body, { partialRuns: [], completedPullRequest: 7 }),
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
    const history = [];
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
      history.push({
        pullRequest,
        remaining: ["Add recovery.", "Verify restart."],
      });
      assert.deepEqual(scene.state().issues, [
        {
          ...original,
          body: statusBody(body, { partialRuns: history }),
          labels: ["keep", "cloving: ready"],
        },
      ]);
    }
  }));

await test("CLV-123 the third partial blocks instead of requeueing", () =>
  withGithub(async (scene) => {
    const earlier = [
      { pullRequest: 5, remaining: ["First."] },
      { pullRequest: 6, remaining: ["Second."] },
    ];
    scene.plan({
      scores: [],
      issues: [
        {
          ...original,
          body: statusBody(body, { partialRuns: earlier }),
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
      statusBody(body, {
        partialRuns: [...earlier, { pullRequest: 7, remaining: ["Third."] }],
      }),
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
        statusBody(body, {
          partialRuns: [
            {
              pullRequest: 7,
              remaining: ["Remaining work is in the private run report."],
            },
          ],
        }),
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
    const earlier = [{ pullRequest: 5, remaining: ["Tests."] }];
    scene.plan({
      scores: [],
      issues: [
        {
          ...original,
          body: statusBody(body, { partialRuns: earlier }),
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
      statusBody(body, { partialRuns: earlier, completedPullRequest: 7 }),
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
