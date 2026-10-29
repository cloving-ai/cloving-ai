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

function originProbe(origin: string, commands: string[][]): ProbeRunner {
  const fallback = probe();
  return (program, options) => {
    if (program === "git")
      return Promise.resolve({ stdout: origin, reason: null });
    if (program === "gh") {
      commands.push([...options.arguments]);
      return Promise.resolve({ stdout: "repository-user\n", reason: null });
    }
    return fallback(program, options);
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

await test("CLV-225 login uses the origin host despite a different GH_HOST", () =>
  withFiles({}, async (repository) => {
    for (const [origin, host] of [
      ["git@github.example.com:example/project.git", "github.example.com"],
      ["https://github.example.com/example/project.git", "github.example.com"],
      ["git@github.com:example/project.git", "github.com"],
    ] as const) {
      const commands: string[][] = [];
      const facts = await initPromptFacts({
        repository,
        environment: {
          HOME: repository,
          PATH: "",
          GH_HOST: "other.example.com",
        },
        probe: originProbe(origin, commands),
      });
      assert.deepEqual(commands, [
        ["api", "user", "--hostname", host, "--jq", ".login"],
      ]);
      assert.equal(facts.origin, origin);
      assert.equal(facts.login, "repository-user");
    }
  }));
