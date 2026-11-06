import assert from "node:assert/strict";
import { test } from "node:test";
import { withGithub } from "./github-worker-fixture.ts";

const payload = {
  owner: "acme",
  repository: "demo",
  number: 42,
  add: ["cloving: in progress"],
  remove: [],
};

for (const [detail, reason] of [
  ["gh: Server Error (HTTP 502)", "github-network-failed"],
  ["gh: HTTP 503", "github-network-failed"],
  ["gh: Not Found (HTTP 404)", "github-call-failed"],
  ["gh: refused HTTP 5000 bytes", "github-call-failed"],
] as const)
  await test(`CLV-300 a GitHub call that fails with ${detail} reports ${reason}`, () =>
    withGithub(async (scene) => {
      scene.plan({
        scores: [],
        labels: [{ repository: "acme/demo", name: "cloving: in progress" }],
        issues: [{ repository: "acme/demo", number: 42, labels: [] }],
        failures: [{ call: "issue edit", detail }],
      });
      const worker = scene.worker({});
      const report = await scene.perform(worker, { method: "label", payload });
      assert.equal(report.outcome, "failed");
      assert.equal(report.reason, reason);
    }));
