import assert from "node:assert/strict";
import { test } from "node:test";
import { withGithub } from "./github-worker-fixture.ts";

const payload = {
  owner: "acme",
  repository: "demo",
  number: 42,
  pullRequest: 7,
  remaining: ["Finish tests."],
};
const original = {
  repository: "acme/demo",
  number: 42,
  state: "open",
  body: "Original.",
  labels: ["keep"],
};
const settings = { privateTexts: ["secret-project"] };

await test("CLV-123 malformed issue reads cannot overwrite the issue body", () =>
  withGithub(async (scene) => {
    const worker = scene.worker(settings);
    for (const change of [
      { body: 17 },
      { number: 99 },
      { state: "unknown" },
      { pull_request: {} },
    ]) {
      scene.plan({
        scores: [],
        issues: [original],
        replies: { "api GET issue": { ...original, ...change } },
      });
      const report = await scene.perform(worker, {
        method: "partial-issue",
        payload,
      });
      assert.equal(report.outcome, "failed", JSON.stringify(change));
      assert.deepEqual(scene.state().issues, [original]);
    }
  }));

await test("CLV-123 invalid status payloads fail before any GitHub call", () =>
  withGithub(async (scene) => {
    const worker = scene.worker(settings);
    for (const change of [
      { owner: "a/b" },
      { number: 0 },
      { number: Number.MAX_SAFE_INTEGER + 1 },
      { pullRequest: "7" },
      { remaining: [] },
      { remaining: ["two\nlines"] },
    ]) {
      const report = await scene.perform(worker, {
        method: "partial-issue",
        payload: { ...payload, ...change },
      });
      assert.equal(report.reason, "invalid-payload");
    }
    assert.deepEqual(scene.state().calls, []);
  }));
