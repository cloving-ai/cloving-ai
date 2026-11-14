import assert from "node:assert/strict";
import { test } from "node:test";
import { methods } from "../src/daemon/github-methods.ts";
import { withGithub } from "./github-worker-fixture.ts";

await test("CLV-363 issue-states reads open, closed and missing issues without writes", () =>
  withGithub(async (scene) => {
    assert.ok(methods.has("issue-states"));
    scene.plan({
      scores: [],
      sequences: {
        "api GET issue": [
          { number: 734, state: "open" },
          { number: 702, state: "closed" },
          { number: 700, state: "open", pull_request: {} },
        ],
      },
    });
    const report = await scene.perform(scene.worker(), {
      method: "issue-states",
      payload: { numbers: [734, 702, 700] },
    });
    assert.equal(report.outcome, "completed", JSON.stringify(report));
    assert.deepEqual(JSON.parse(String(report.result)), [
      { number: 734, state: "open" },
      { number: 702, state: "closed" },
      { number: 700, state: "missing" },
    ]);
    assert.deepEqual(
      scene.state().calls,
      [734, 702, 700].map((number) => [
        "api",
        `repos/{owner}/{repo}/issues/${String(number)}`,
      ]),
    );
  }));

await test("CLV-363 issue-states refuses invalid payloads before GitHub and accepts fifty numbers", () =>
  withGithub(async (scene) => {
    assert.ok(methods.has("issue-states"));
    scene.plan({
      scores: [],
      replies: { "api GET issue": { state: "closed" } },
    });
    const worker = scene.worker();
    for (const payload of [
      {},
      { numbers: [] },
      { numbers: Array.from({ length: 51 }, (_, index) => index + 1) },
      ...[0, -1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1].map((number) => ({
        numbers: [number],
      })),
      { numbers: "1" },
      { numbers: [1], extra: true },
    ]) {
      const report = await scene.perform(worker, {
        method: "issue-states",
        payload,
      });
      assert.equal(
        report.reason,
        "invalid-github-input",
        JSON.stringify(payload),
      );
    }
    assert.deepEqual(scene.state().calls, []);
    const report = await scene.perform(worker, {
      method: "issue-states",
      payload: { numbers: Array.from({ length: 50 }, (_, index) => index + 1) },
    });
    assert.equal(report.outcome, "completed", JSON.stringify(report));
    const result: unknown = JSON.parse(String(report.result));
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 50);
  }));

await test("CLV-363 issue-states maps HTTP 404 and 410 to missing and preserves other failures", () =>
  withGithub(async (scene) => {
    assert.ok(methods.has("issue-states"));
    const worker = scene.worker();
    for (const status of [404, 410]) {
      scene.plan({
        scores: [],
        failures: [
          {
            call: "api GET issue",
            detail: `gh: refused (HTTP ${String(status)})`,
          },
        ],
      });
      const report = await scene.perform(worker, {
        method: "issue-states",
        payload: { numbers: [734] },
      });
      assert.deepEqual(JSON.parse(String(report.result)), [
        { number: 734, state: "missing" },
      ]);
    }
    scene.plan({
      scores: [],
      failures: [{ call: "api GET issue", detail: "gh: refused (HTTP 403)" }],
    });
    const failed = await scene.perform(worker, {
      method: "issue-states",
      payload: { numbers: [734] },
    });
    assert.equal(failed.reason, "github-call-failed");
    for (const reply of [null, {}, { state: "merged" }, { state: 1 }]) {
      scene.plan({ scores: [], replies: { "api GET issue": reply } });
      const report = await scene.perform(worker, {
        method: "issue-states",
        payload: { numbers: [734] },
      });
      assert.equal(report.reason, "github-call-failed");
    }
  }));
