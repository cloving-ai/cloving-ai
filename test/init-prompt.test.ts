import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { initPrompt } from "../src/cli/init-prompt.ts";

await test("CLV-225 fixed facts snapshot includes the rules, reachable targets and final summary contract", async () => {
  const output = initPrompt({
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
  });
  assert.match(
    output,
    /3\. Ask for the ticket source[\s\S]*4\. \*\*Find the loops that the user already does\.\*\*[\s\S]*5\. /,
  );
  assert.match(output, /at most 50 rows/);
  assert.match(output, /cut to 80 characters/);
  assert.match(output, /at most 10 sessions/);
  assert.match(output, /at most 20,000 bytes/);
  assert.match(output, /at most 5 candidates/);
  assert.match(output, /closed loop only when their outputs make a cycle/);
  assert.match(output, /If the user says no, go to the next step/);
  assert.equal(
    output,
    await readFile(
      new URL("./snapshots/init-prompt.md", import.meta.url),
      "utf8",
    ),
  );
});
