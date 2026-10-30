import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { initPrompt, type InitPromptFacts } from "../src/cli/init-prompt.ts";

const facts: InitPromptFacts = {
  version: "1.3.0",
  repository: "<repository>",
  origin: "git@github.com:example/project.git",
  login: "setup-user",
  node: "v26.9.0",
  harnesses: [{ name: "codex", version: "0.100.0", working: true }],
  defaultHarness: "codex",
  worker: "native codex",
  runtime: "<runtime>",
  chatStores: [],
  files: [".cloving/config.json"],
  templates: ["develop: 5 decision points"],
  workflows: [],
};

await test("CLV-228 first-workflow setup defers no-workflow to the template step and checks it after copying", () => {
  const output = initPrompt(facts);
  const first = output.split("\n").find((line) => line.startsWith("1. Run"));
  const template = output.split("\n").find((line) => line.startsWith("5. "));
  const verification = output
    .split("\n")
    .find((line) => line.startsWith("8. "));
  assert.ok(first);
  assert.ok(template);
  assert.ok(verification);
  assert.match(first, /Defer `no-workflow` to the template step/);
  assert.match(first, /Do not run `cloving init`/);
  assert.match(template, /cloving templates copy <name>/);
  assert.match(template, /Run `cloving doctor --json` again after the copy/);
  assert.match(template, /`no-workflow` must give `ok`/);
  assert.match(verification, /including `no-workflow`/);
  assert.doesNotMatch(
    output,
    /develop-(?:issue|ticket|prompt|prd)|bundled workflows/,
  );
});

await test("CLV-228 setup queue guidance requires an explicit queue declaration", () => {
  const queue = initPrompt(facts)
    .split("\n")
    .find((line) => line.startsWith("- Queue facts"));
  assert.ok(queue);
  assert.match(queue, /no workflow has `queue: true`, no queue starts/);
  assert.doesNotMatch(queue, /bundled|develop-issue/);
});

await test("CLV-225 fixed facts snapshot includes the rules, reachable targets and final summary contract", async () => {
  const output = initPrompt(facts);
  assert.match(
    output,
    /3\. Ask for the ticket source[\s\S]*4\. \*\*Find the loops that the user already does\.\*\*[\s\S]*5\. /,
  );
  assert.match(output, /at most 50 rows/);
  assert.match(
    output,
    /Unavailable stores have an error code and null measurements; report them and continue setup with the remaining facts/,
  );
  assert.match(
    output,
    /Before any count output enters this session, use shell tools to cut every text field to at most 80 characters, including repeated messages, commands, tool calls, session identifiers and file references/,
  );
  assert.match(
    output,
    /Count using the full values before truncation so distinct values with the same prefix stay separate/,
  );
  assert.match(output, /cut to 80 characters/);
  assert.match(output, /at most 10 sessions/);
  assert.match(output, /at most 20,000 bytes/);
  assert.match(output, /at most 5 candidates/);
  assert.match(output, /closed loop only when their outputs make a cycle/);
  assert.match(output, /If the user says no, go to the next step/);
  assert.match(
    output,
    /For every runtime value, including CLOVING_RUNTIME_DIR overrides, resolve the notes destination and its existing parent directories, following symbolic links, before writing/,
  );
  assert.match(
    output,
    /If the runtime is unavailable or the resolved destination is inside the repository, choose and verify an outside location first/,
  );
  assert.equal(
    output,
    await readFile(
      new URL("./snapshots/init-prompt.md", import.meta.url),
      "utf8",
    ),
  );
});
