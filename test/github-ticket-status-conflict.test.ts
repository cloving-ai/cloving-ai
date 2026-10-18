import assert from "node:assert/strict";
import { test } from "node:test";
import { withGithub } from "./github-worker-fixture.ts";

const payload = {
  owner: "acme",
  repository: "demo",
  number: 42,
  pullRequest: 7,
  remaining: ["Add recovery."],
};
const original = {
  repository: "acme/demo",
  number: 42,
  state: "open",
  body: "Original body.",
  labels: ["keep", "cloving: in progress"],
};
const settings = { privateTexts: ["private-project"] };

for (const method of ["partial-issue", "close-issue"])
  await test(`CLV-123 ${method} preserves concurrent unrelated label additions and removals`, () =>
    withGithub(async (scene) => {
      scene.plan({
        scores: [],
        issues: [original],
        issueEditAfterRead: { labels: ["new-label", "cloving: in progress"] },
      });
      const report = await scene.perform(scene.worker(settings), {
        method,
        payload,
      });
      assert.equal(report.outcome, "completed", JSON.stringify(report));
      assert.deepEqual(
        scene.state().issues[0]?.["labels"],
        method === "partial-issue"
          ? ["new-label", "cloving: ready"]
          : ["new-label"],
      );
      assert.ok(
        scene
          .state()
          .calls.every(
            (call) => !call.some((part) => part.startsWith("labels[]")),
          ),
      );
    }));

for (const method of ["partial-issue", "close-issue"])
  await test(`CLV-123 ${method} refuses a conflicting body edit before any issue write`, () =>
    withGithub(async (scene) => {
      const body = "The operator changed the requirements.";
      scene.plan({
        scores: [],
        issues: [original],
        issueEditAfterRead: { body },
      });
      const report = await scene.perform(scene.worker(settings), {
        method,
        payload,
      });
      assert.equal(report.outcome, "failed");
      assert.equal(report.reason, "github-issue-conflict");
      assert.deepEqual(scene.state().issues, [{ ...original, body }]);
      assert.ok(
        scene
          .state()
          .calls.every(
            (call) => !call.includes("PATCH") && call[0] !== "issue",
          ),
      );
    }));
