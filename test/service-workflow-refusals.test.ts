import assert from "node:assert/strict";
import { test } from "node:test";
import { admitted, call, field, withHarness } from "./service-fixture.ts";

const project = {
  scope: "project" as const,
  label: "broken.ts",
  codes: ["compile-failed"],
};
const user = {
  scope: "user" as const,
  label: "workflows/",
  codes: ["workflow-read-failed"],
};
const expected = [project, user];

await test("CLV-124 status exposes sorted safe refusal records with zero runs", () =>
  withHarness(async (harness) => {
    const diagnostic = {
      ...project,
      codes: ["compile-failed", "compile-failed"],
      source: "SOURCE_SENTINEL",
      compilerOutput: "COMPILER_SENTINEL",
      path: "/private/MACHINE_SENTINEL/broken.ts",
    };
    await harness.start({
      workflowRefusals: [user, diagnostic],
    });
    const list = await call(harness, { operation: "status", parameters: {} });
    assert.deepEqual(field(list, "workflowRefusals"), expected);
    assert.deepEqual(field(list, "runs"), []);
    assert.deepEqual(field(list, "workflows"), ["develop"]);
    assert.doesNotMatch(JSON.stringify(list), /SENTINEL/);
    const refused = await call(harness, {
      operation: "run",
      parameters: {
        workflowId: "broken",
        source: "prompt",
        submission: { prompt: "synthetic" },
        commandId: "refused-workflow",
      },
    });
    assert.equal(field(refused, "kind"), "error");
    assert.deepEqual(harness.resolved, []);
    assert.deepEqual(harness.sent, []);
  }));

await test("CLV-124 every run-list page carries the same refusals", () =>
  withHarness(async (harness) => {
    await harness.start({ workflowRefusals: [user, project] });
    await admitted(harness, "one");
    await admitted(harness, "two");
    const first = await call(harness, {
      operation: "status",
      parameters: { limit: 1 },
    });
    const second = await call(harness, {
      operation: "status",
      parameters: { limit: 1, after: field(first, "next") },
    });
    assert.deepEqual(field(first, "workflowRefusals"), expected);
    assert.deepEqual(field(second, "workflowRefusals"), expected);
    assert.equal(field(second, "next"), null);
  }));

await test("CLV-124 bundled-only service reports an empty refusal list", () =>
  withHarness(async (harness) => {
    await harness.start();
    const list = await call(harness, { operation: "status", parameters: {} });
    assert.deepEqual(field(list, "workflowRefusals"), []);
  }));
