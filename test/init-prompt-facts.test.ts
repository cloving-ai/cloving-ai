import assert from "node:assert/strict";
import { test } from "node:test";
import { initPromptFacts } from "../src/cli/init-prompt-command.ts";
import type { ProbeOutput, ProbeRunner } from "../src/cli/probe-command.ts";
import { withFiles } from "./quality/files-fixture.ts";

function probe(
  outputs: Readonly<Record<string, ProbeOutput>> = {},
): ProbeRunner {
  return (_program, options) => {
    const tool = options.arguments[0]?.includes("template-command")
      ? "template"
      : "workflow";
    if (options.arguments[0]?.includes("-command"))
      return Promise.resolve(outputs[tool] ?? { stdout: "[]", reason: null });
    return Promise.resolve({ stdout: "", reason: "fixture-unavailable" });
  };
}

await test("CLV-225 failed fact probes remain unavailable and omit private settings", () =>
  withFiles({}, async (repository) => {
    const facts = await initPromptFacts({
      repository,
      environment: { HOME: repository, PATH: "" },
      probe: probe(),
    });
    assert.equal(facts.origin, "unavailable");
    assert.equal(facts.login, "unavailable");
    assert.deepEqual(facts.templates, []);
    assert.deepEqual(facts.workflows, []);
  }));

await test("CLV-225 invalid or failed listing results cannot become setup facts", () =>
  withFiles({}, async (repository) => {
    for (const output of [
      { stdout: "[]", reason: "probe-timeout" },
      { stdout: "{}", reason: null },
      { stdout: "[null]", reason: null },
      {
        stdout: '[{"scope":5,"workflowId":"custom","file":"workflow.ts"}]',
        reason: null,
      },
    ]) {
      await assert.rejects(
        initPromptFacts({
          repository,
          environment: { HOME: repository, PATH: "" },
          probe: probe({ workflow: output }),
        }),
        /workflow-inspection/,
      );
    }
  }));

await test("CLV-225 a missing repository gives a clear prerequisite", async () => {
  await assert.rejects(
    initPromptFacts({ repository: undefined, environment: {}, probe: probe() }),
    /repository-unknown/,
  );
});
